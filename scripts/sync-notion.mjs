// Pulls site content from Notion and saves it as JSON (and images) for the site.
// Runs in GitHub Actions with the NOTION_TOKEN secret. Node 20+, no packages needed.
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';

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
  siteText: 'e0cc95bb4b614f469dd6b46bd28cf0fb',   // Site Text (every heading and paragraph on the main pages)
  life: '337855e9a340441babb8635db71c5c15',       // Life Updates (Now page)
  published: 'd118cdf7a55348a4b35f4380e2a17e34',  // Published
  stack: '9f5c1f4ef2c54e00b8b599fde961f6f1',      // Stack (Bookmarks)
  bookmarks: 'd3df2165dac64f58bb18c0edff9eb02f',  // Bookmarks & Blogroll
  shelf: '2eb428337da9497ba42716c77eacc641',      // Shelf (books, shows, podcasts, music)
  events: 'b31f534e4f464931b9bfbe56b0ca944d',     // Events
  resources: '66b0bda8a1ab432186ac44caf727c4f8',  // Resources
  photography: '6d53b91ce5e24ff5bae6858768caea7b',// Photography
  academia: 'b34ae81e18ea4ed2b7a093baf55bfbff',   // Academia
  resume: '271893e36dac4c8fbcc6da355af4d98c',     // Resume Lists (Work page lists, In kitchens)
  aboutLists: '46f20b4644bc496588567cb26be69015', // About Lists
  kitchen: '3c58ed346e0b423986f73ddac19aa2e5',    // Kitchen Photos (Archive)
  glossary: '19b1f26619394353a5fc42541805a41b',                     // Glossary (Appendix)
  cases: '59d300da5ba94a55a8f6c54f2ebe88a5',      // Case Studies (Work page + case study pages)
  sitePages: 'bfc0fc750c634184858700889ae7b79e',  // Site Pages & Links (Changelog, Colophon, Legal, AI use, new pages, menu and footer links)
};
// A link or @mention to one of these databases in a Notion page goes to that page of the site
const DB_PAGE = { notes: 'notes', states: 'states', projects: 'projects', life: 'now', published: 'published', stack: 'bookmarks', bookmarks: 'bookmarks', shelf: 'bookmarks',
  events: 'events', resources: 'resources', photography: 'photography', academia: 'academia', resume: 'portfolio', aboutLists: 'about', kitchen: 'archive', glossary: 'appendix', cases: 'portfolio' };
const PAGE_BY_DB = Object.fromEntries(Object.entries(DB_PAGE).map(([k, v]) => [DB[k], v]));
const LITERAL = 'ChefAK';
const LETTERBOXD = 'eauxjai';

// Films saved by earlier runs (Letterboxd's feed only holds recent diary entries)
let savedFilms = [], savedBooks = [];
try { const old = JSON.parse(await readFile('data/shelf.json', 'utf8')); savedFilms = old.films || []; savedBooks = old.books || []; } catch {}
await rm('assets', { recursive: true, force: true });
// Photos are resized so they load fast and stay under Cloudflare's 25 MB file limit
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { console.log('Note: photo resizing is off (sharp is not installed).'); }

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
const idOf = s => String(s || '').replace(/-/g, '');
const slugify = s => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function saveFile(url, folder, name, max = 2000) {
  if (!url) return '';
  try {
    const res = await fetch(url); if (!res.ok) return '';
    const type = res.headers.get('content-type') || '';
    let ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : type.includes('pdf') ? 'pdf' : type.includes('svg') ? 'svg' : type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : type.includes('webm') ? 'webm' : type.includes('audio') || type.includes('mpeg') ? 'mp3' : 'jpg';
    let buf = Buffer.from(await res.arrayBuffer());
    if (sharp && /^image\/(jpeg|jpg|png|webp|heic|heif|tiff|avif)/.test(type)) {
      try {
        const img = sharp(buf, { failOn: 'none' }).rotate();
        const meta = await img.metadata();
        const fit = img.resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
        if (meta.hasAlpha) { buf = await fit.png({ compressionLevel: 9, palette: true }).toBuffer(); ext = 'png'; }
        else { buf = await fit.jpeg({ quality: 80, mozjpeg: true }).toBuffer(); ext = 'jpg'; }
      } catch (e) { console.warn(`Could not resize ${name}: ${e.message}`); }
    }
    if (buf.length > 24 * 1024 * 1024) { console.warn(`Skipped ${folder}/${name}: over 24 MB even after resizing. Upload a smaller file.`); return ''; }
    await mkdir(`assets/${folder}`, { recursive: true });
    const path = `assets/${folder}/${name}.${ext}`;
    await writeFile(path, buf);
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
  // Image upload wins; Image link (a web address of a photo) is the fallback
  const image = (await saveProp(p, pr.Image, 'hover')) || (pr['Image link']?.url ? await saveFile(pr['Image link'].url, 'hover', p.id.replace(/-/g, '')) : '');
  hover[name.toLowerCase()] = { image, caption: plain(pr.Caption), link: pr.Link?.url || '', wide: check(pr.Wide) };
}

// ---------- long pages ----------
// Publish = live and listed. Preview = built at its link only (adjoakittoe.com/#slug), never listed.
const allPieceRows = await queryAll(DB.pieces);
const pieceRows = allPieceRows.filter(p => check(p.properties.Publish) || check(p.properties.Preview));
const slugById = {};
// unpublished rows with a Slug are the hand-built pages (Fonio, Pantry...): links to them still work
for (const p of allPieceRows) if (plain(p.properties.Slug)) slugById[p.id.replace(/-/g, '')] = plain(p.properties.Slug);
for (const p of pieceRows) slugById[p.id.replace(/-/g, '')] = plain(p.properties.Slug) || slugify(plain(p.properties.Title));

// Case studies and site pages: their rows link to their own pages
const caseRows = await queryAll(DB.cases).catch(e => { console.warn(`Skipped cases: ${e.message}`); return []; });
const sitePageRows = await queryAll(DB.sitePages).catch(e => { console.warn(`Skipped site pages: ${e.message}`); return []; });
const caseSlug = p => 'case-' + (plain(p.properties.Slug).replace(/^case-/, '') || slugify(plain(p.properties.Org)));
for (const p of caseRows) slugById[idOf(p.id)] = caseSlug(p);
for (const p of sitePageRows) { const sl = plain(p.properties.Slug).replace(/^#/, '') || slugify(plain(p.properties.Title)); if (sl) slugById[idOf(p.id)] = sl; }

const guideRows = [];
for (const p of await queryAll(DB.guideItems)) {
  const pr = p.properties; if (!check(pr.Publish)) continue;
  guideRows.push({ pageIds: (pr.Page?.relation || []).map(r => r.id.replace(/-/g, '')), name: plain(pr.Name), section: plain(pr.Section) || 'More', type: pr.Type?.select?.name || 'Tool', note: plain(pr.Note), category: plain(pr.Category), link: pr.Link?.url || '', page: plain(pr['Links to page']), color: plain(pr['Icon color']), order: pr.Order?.number ?? 999, image: await saveProp(p, pr.Image, 'guide') });
}

// ---------- turning Notion blocks into the site's own components ----------
// Every block below outputs the same markup as the hand-built pages and the Style Guide,
// so it picks up the same look and behavior.
const txt = rt => (rt || []).map(t => t.plain_text).join('');
const ARROW_DL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
const SEC_COLORS = { ingredients: '#d0644a', method: '#4a7fb5', notes: '#b8922e' };

// Photo on hover: purple word + an image right under it with the caption "Hover: word".
// Each image belongs only to its own page, so the same word can show different photos.
function hoverSpan(inner, word, ctx) {
  const q = ctx?.hovers?.[word.trim().toLowerCase()];
  const h = q && q.length ? q.shift() : null;
  if (!h || !h.src) return inner;
  return `<span class="ab-photo" data-own tabindex="0">${inner}<template class="ab-photo-art"><figure class="ab-photo-card"><img src="${esc(h.src)}" alt="${esc(h.cap || word)}">${h.cap ? `<figcaption>${esc(h.cap)}</figcaption>` : ''}</figure></template></span>`;
}
async function collectHovers(blocks, ctx, pageId) {
  ctx.hovers = {}; let k = 0;
  const walk = async list => {
    for (const b of list || []) {
      if (b.type === 'image') {
        const cap = txt(b.image.caption).trim(); const m = cap.match(/^hover\s*:\s*([^|]+?)\s*(?:\|\s*(.*))?$/i);
        if (m) { b._hover = true; const src = await saveFile(fileUrl(b.image), 'hover', `${pageId}-${k++}`, 900); (ctx.hovers[m[1].toLowerCase()] ||= []).push({ src, cap: (m[2] || '').trim() }); }
      }
      if (b.children) await walk(b.children);
    }
  };
  await walk(blocks);
}

// Which site page a Notion page/database id, a Notion link, or an adjoakittoe.com link points to ('' = not on the site)
const sitePage = id => slugById[id] || PAGE_BY_DB[id] || '';
function siteHref(href) {
  const h = String(href || '');
  const own = h.match(/^(?:https?:\/\/)?(?:www\.)?(?:adjoakittoe\.com|adjoakittoe\.pages\.dev)\/?(?:index\.html)?#?\/?([\w-]*)/i);
  if (own) return own[1] || 'home';
  if (/^(?:https?:\/\/[^/]*notion\.(?:so|site|com)\/|\/)/.test(h)) { const m = h.replace(/#.*$/, '').match(/([0-9a-f]{32})(?:[?]|$)/); if (m) return sitePage(m[1]); }
  return '';
}
function rich(rt = [], ctx = {}) {
  return rt.map(t => {
    const raw = t.plain_text;
    let s = esc(raw).replace(/\n/g, '<br>');
    const a = t.annotations || {};
    if (a.code && /^ai drafted$/i.test(raw.trim())) s = `<span class="ai-pill" title="Drafted with AI. See the AI use page.">${s}</span>`;
    else if (a.code) s = /^#[\w-]+$/.test(raw.trim()) ? `<span class="es-tag">${s}</span>` : raw.trim().length <= 3 ? `<kbd>${s}</kbd>` : `<code>${s}</code>`;
    if (a.bold) s = `<strong>${s}</strong>`;
    if (a.italic) s = `<em>${s}</em>`;
    if (a.strikethrough) s = `<s>${s}</s>`;
    if (a.underline) s = `<u>${s}</u>`;
    if (a.color === 'yellow_background') s = `<mark>${s}</mark>`;
    else if (a.color === 'gray') s = `<span class="muted">${s}</span>`;
    else if (a.color === 'gray_background') s = `<span class="lf-tag">${s}</span>`;
    else if (a.color === 'purple') s = hoverSpan(s, raw, ctx);
    else if (a.color === 'blue') { const m = raw.match(/^([\s\S]*?)\s*\(([^()]+)\)\s*$/); if (m && m[1].trim()) { if (!ctx.preview) HINTS.push({ term: m[1].trim(), definition: m[2].trim(), page: ctx.slug || '' }); } if (m && m[1].trim()) s = `<span class="np-hint" tabindex="0">${esc(m[1].trim())}<span class="np-hint-box" role="tooltip">${esc(m[2].trim())}</span></span>${/\s$/.test(raw) ? ' ' : ''}`; }
    // links
    // @mention of a page or database: green link with an arrow
    const mType = t.type === 'mention' ? t.mention?.type : '';
    const mention = mType === 'page' || mType === 'database' ? idOf(t.mention[mType].id) : null;
    const mSlug = mention && sitePage(mention);
    if (mSlug) s = `<a href="#" data-page="${esc(mSlug)}" class="site-link">${s} <span>→</span></a>`;
    else if (t.href && !mention) {
      const block = t.href.match(/#([0-9a-f]{32})$/);
      const page = siteHref(t.href);
      if (block && ctx.anchors && ctx.anchors[block[1]]) s = `<a href="#${ctx.anchors[block[1]]}" class="site-link sg-jump" data-jump="${ctx.anchors[block[1]]}">${s} <span>↓</span></a>`;
      else if (page) s = `<a href="#" data-page="${esc(page)}" class="np-in">${s}</a>`;
      else if (/^https?:|^mailto:/.test(t.href)) s = `<a class="ab-link" href="${esc(t.href)}" target="_blank" rel="noopener">${s}<span class="ab-ext">↗</span></a>`;
    }
    return s;
  }).join('');
}
// [1] or [1, 4] after a sentence becomes the site's citation marker with the pop-up source
const cites = (html, ctx) => html.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (_, list) =>
  `<sup class="cite">${list.split(/\s*,\s*/).map(n => `<a href="#${ctx.slug}-src-${n}" data-cite="${n}">${n}</a>`).join(',')}</sup>`);
// gray instruction lines keep [1] as typed
const para = (rt, ctx) => (rt.length && rt.every(r => r.annotations?.color === 'gray')) ? rich(rt, ctx) : cites(rich(rt, ctx), ctx);

// One Notion line split into lines (Shift+Enter), each a list of rich text pieces
function lines(rt = []) {
  const out = [[]];
  for (const r of rt) r.plain_text.split('\n').forEach((p, k) => { if (k) out.push([]); if (p) out[out.length - 1].push({ ...r, plain_text: p }); });
  return out.filter(l => l.length);
}

// Sources list entry: title (linked) with an optional gray-background tag; next line is the note
function sourceItem(x, n, ctx) {
  const ls = lines(x.numbered_list_item.rich_text);
  const first = ls[0] || [], rest = ls.slice(1);
  const tags = first.filter(r => r.annotations?.color === 'gray_background').map(r => `<span class="lf-tag">${esc(r.plain_text.trim())}</span>`).join(' ');
  const titleParts = first.filter(r => r.annotations?.color !== 'gray_background');
  const href = titleParts.find(r => r.href)?.href;
  const title = esc(titleParts.map(r => r.plain_text).join('').trim().replace(/[.,;:]$/, ''));
  const titleHtml = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${title} ↗</a>` : title;
  let note = rest.map(l => rich(l, ctx)).join('<br>');
  if (x.children) note += x.children.filter(c => c.type === 'paragraph').map(c => rich(c.paragraph.rich_text, ctx)).join('<br>');
  return `<li class="lf-src" id="${ctx.slug}-src-${n}"><span class="lf-src-n">${n}</span><div><div class="lf-src-title">${titleHtml}${tags ? ' ' + tags : ''}</div><div class="lf-src-note">${note}</div></div></li>`;
}

const UNITS = 'cups?|tbsp|tsp|tablespoons?|teaspoons?|g|kg|ml|l|oz|lbs?|pounds?|pinch(?:es)?|cloves?|cans?|small|medium|large|bunch(?:es)?|sprigs?|slices?|pieces?|handfuls?|sticks?|stalks?|inch(?:es)?';
function ingredient(x) {
  const frac = { '½': .5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': .25, '¾': .75, '⅛': .125 };
  const s = txt(x.bulleted_list_item.rich_text).trim();
  const m = s.match(new RegExp(`^((?:\\d+\\s+)?(?:\\d+\\/\\d+|\\d*\\.?\\d+|[½⅓⅔¼¾⅛])(?:\\s*[½⅓⅔¼¾⅛])?)\\s*(${UNITS})?\\b\\s*(.*)$`, 'i'));
  if (!m) return `<li><span class="rc-q" data-q=""></span> <span class="rc-u"></span> ${esc(s)}</li>`;
  let n = 0; for (const part of m[1].trim().split(/\s+/)) { if (frac[part]) n += frac[part]; else if (part.includes('/')) { const [a, c] = part.split('/'); n += a / c; } else if (/^\d*\.?\d+[½⅓⅔¼¾⅛]$/.test(part)) { n += parseFloat(part) + frac[part.slice(-1)]; } else n += parseFloat(part); }
  return `<li><span class="rc-q" data-q="${+n.toFixed(4)}">${esc(m[1].trim())}</span> <span class="rc-u">${esc(m[2] || '')}</span> ${esc(m[3])}</li>`;
}

// YouTube (watch, youtu.be, shorts, live) and Vimeo links become a video card that plays on the page
function videoCard(url, cap, push) {
  const yt = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/), vm = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (!yt && !vm) return false;
  const embed = yt ? `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1` : `https://player.vimeo.com/video/${vm[1]}?autoplay=1`;
  const thumb = yt ? `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg` : '';
  push(`<button type="button" class="np-video" data-embed="${esc(embed)}" data-title="${esc(cap)}">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : ''}<span class="rc-play" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg></span>${cap ? `<span class="np-video-cap">${esc(cap)}</span>` : ''}</button>`, { wide: true });
  return true;
}
// Google Forms and Tally forms show inside the page
function formUrl(url) {
  const u = String(url);
  if (/docs\.google\.com\/forms\//.test(u)) return u.replace(/\/(viewform|edit)?(\?.*)?$/, '/viewform') + '?embedded=true';
  const ta = u.match(/tally\.so\/(?:r|embed)\/(\w+)/); if (ta) return `https://tally.so/embed/${ta[1]}?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1`;
  return '';
}
const HINTS = []; // blue hover words, also added to the Appendix glossary
const SKIPPED = new Set(); // block types the site cannot show yet (listed in the sync log)
async function saveImg(v, id) { return saveFile(fileUrl(v), 'pieces', idOf(id)); }

// An image block: caption keywords pick the shape. (wide) (square) (round) (circle) (tilt). "caption | credit" adds a credit.
async function figure(b, ctx) {
  let cap = txt(b.image.caption).trim();
  const flags = {}; cap = cap.replace(/\((wide|square|round|circle|tilt)\)/gi, (_, f) => { flags[f.toLowerCase()] = 1; return ''; }).trim();
  const src = await saveImg(b.image, b.id); if (!src) return '';
  ctx.images.push({ src, cap });
  const [text, credit] = cap.split(/\s*\|\s*/);
  const shape = flags.square ? ' sq' : flags.round ? ' round' : flags.circle ? ' circle' : ' rect';
  const img = `<img class="sg-img${shape} sg-pop" src="${esc(src)}" alt="${esc(text || '')}" loading="lazy">`;
  const fc = text || credit ? `<figcaption><span>${esc(text || '')}</span>${credit ? `<span class="lf-credit">${esc(credit)}</span>` : ''}</figcaption>` : '';
  if (flags.tilt) return `<figure class="lf-figure"><div class="wh-tilt">${img}</div>${fc}</figure>`;
  // (wide) = full width, edge to edge across the page, like the hue chart on Visual Research
  if (flags.wide) return `<figure class="lf-bleed np-bleed"><div class="lf-bleed-inner">${img.replace(' rect', '')}</div>${fc}</figure>`;
  return `<figure class="lf-figure${flags.wide ? ' np-wide' : ''}">${img}${fc}</figure>`;
}

// Pull nested callouts out of a block's children: they become side notes
function splitKids(kids = []) { return { kids: kids.filter(k => k.type !== 'callout'), notes: kids.filter(k => k.type === 'callout') }; }

// ---------- named toggles that rebuild the hand-built page pieces ----------
const TOOL_COLORS = ['#3b1d36', '#5d7d63', '#a4532f', '#4f6f8a', '#82566f', '#66692f'];
const itemText = x => x[x.type]?.rich_text || [];
// first bold words of a line = name; the rest = note
function splitBold(rt) { let i = 0; while (i < rt.length && (rt[i].annotations?.bold || !rt[i].plain_text.trim())) i++; return { name: rt.slice(0, i), rest: rt.slice(i) }; }
const firstHref = rt => (rt.find(r => r.href) || {}).href || '';
const linkAttrs = href => { const pg = siteHref(href); return pg ? `href="#" data-page="${esc(pg)}"` : `href="${esc(href)}" target="_blank" rel="noopener"`; };
const smallGray = (rt, ctx) => rt.map(r => r.annotations?.color === 'gray' ? `<small>${esc(r.plain_text)}</small>` : rich([r], ctx)).join('');
async function namedToggle(label, kids, ctx) {
  const L = label.toLowerCase();
  const items = kids.filter(k => /list_item|to_do/.test(k.type));
  if (L === 'photo cards') {
    let h = ''; for (const k of kids) {
      if (k.type === 'image') { const src = await saveImg(k.image, k.id); const [cap, link] = txt(k.image.caption).split(/\s*\|\s*/); const fig = `<figure class="ws-card">${src ? `<img src="${esc(src)}" alt="${esc(cap || '')}" loading="lazy">` : ''}<figcaption><span>${esc(cap || '')}</span>${link ? '<span class="ws-arr">↗</span>' : ''}</figcaption></figure>`; h += link ? `<a ${linkAttrs(link)} class="ws-card-link">${fig}</a>` : fig; }
      else if (/list_item/.test(k.type)) h += `<figure class="ws-card"><div class="ws-ph" style="aspect-ratio:4 / 5"><span>${esc(txt(itemText(k)))}</span></div><figcaption><span>${esc(txt(itemText(k)))}</span></figcaption></figure>`;
    }
    return `<div class="ws-cards">${h}</div>`;
  }
  if (L === 'steps') return `<div class="ws-steps">${items.map((k, n) => { const { name, rest } = splitBold(itemText(k)); return `<div class="ws-step"><span class="ws-n">${String(n + 1).padStart(2, '0')}</span><h3>${esc(txt(name).trim())}</h3><p>${rich(rest, ctx).trim()}</p></div>`; }).join('')}</div>`;
  if (L === 'tools' || L === 'plain tools') {
    const plain = L === 'plain tools';
    const tools = items.map((k, n) => { const rt = itemText(k), { name, rest } = splitBold(rt), href = firstHref(rt), nm = txt(name).trim() || txt(rt).trim();
      const inner = `${plain ? '' : `<span class="ws-ic" style="background:${TOOL_COLORS[n % TOOL_COLORS.length]}">${esc(nm[0] || '?')}</span>`}<span class="ws-tn">${esc(nm)}</span><span class="ws-tr">${esc(txt(rest).trim())}</span>`;
      return href ? `<a class="ws-tool ws-tool-link" ${linkAttrs(href)}>${inner}</a>` : `<div class="ws-tool">${inner}</div>`; }).join('');
    const notes = kids.filter(k => k.type === 'paragraph' && txt(k.paragraph.rich_text).trim()).map(k => `<p class="ws-note">${rich(k.paragraph.rich_text, ctx)}</p>`).join('');
    return `<div class="ws-tools${plain ? ' pt-hover' : ''}">${tools}</div>${notes}`;
  }
  if (L === 'shop') {
    let h = ''; for (const k of items) { const rt = itemText(k), { name, rest } = splitBold(rt), href = firstHref(rt); const im = (k.children || []).find(c => c.type === 'image'); const src = im ? await saveImg(im.image, im.id) : '';
      h += `<a class="ws-prod" ${href ? linkAttrs(href) : 'href="#"'}><div class="ws-pimg">${src ? `<img src="${esc(src)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : ''}</div><span class="ws-pn">${esc(txt(name).trim())}</span><span class="ws-pc">${esc(txt(rest).trim())}${href ? ' ↗' : ''}</span></a>`; }
    const notes = kids.filter(k => k.type === 'paragraph' && txt(k.paragraph.rich_text).trim()).map(k => `<p class="ws-note">${rich(k.paragraph.rich_text, ctx)}</p>`).join('');
    return `<div class="ws-shop">${h}</div>${notes}`;
  }
  if (L === 'groups') {
    const groups = []; for (const k of kids) { if (k.type === 'paragraph' && txt(k.paragraph.rich_text).trim()) groups.push({ title: txt(k.paragraph.rich_text).trim(), li: [] }); else if (/list_item/.test(k.type) && groups.length) groups[groups.length - 1].li.push(smallGray(itemText(k), ctx)); }
    return `<div class="pt-groups">${groups.map(g => `<div class="pt-group"><h3>${esc(g.title)}</h3><ul>${g.li.map(l => `<li>${l}</li>`).join('')}</ul></div>`).join('')}</div>`;
  }
  if (L === 'favorites') {
    const favs = []; for (const k of kids) { if (k.type !== 'paragraph') continue; const rt = k.paragraph.rich_text; if (!txt(rt).trim()) continue;
      if (boldOnly(k)) favs.push({ title: txt(rt).trim(), ps: [] }); else if (favs.length) { const use = rt[0]?.annotations?.bold && /^use it for/i.test(rt[0].plain_text.trim()); favs[favs.length - 1].ps.push(use ? `<p class="pt-use"><b>${esc(rt[0].plain_text.trim())}</b> ${rich(rt.slice(1), ctx).trim()}</p>` : `<p>${rich(rt, ctx)}</p>`); } }
    return `<div class="pt-favs">${favs.map(f => `<div class="pt-fav"><h3>${esc(f.title)}</h3>${f.ps.join('')}</div>`).join('')}</div>`;
  }
  if (L === 'cards') {
    let h = ''; for (const k of items) { const ls = lines(itemText(k)); const tl = ls[0] || []; const href = firstHref(tl); const im = (k.children || []).find(c => c.type === 'image'); const src = im ? await saveImg(im.image, im.id) : '';
      const meta = ls[1] ? txt(ls[1]).trim() : '', desc = ls[2] ? rich(ls[2], ctx) : '', title = esc(txt(tl).trim()), pg = siteHref(href);
      const yt = String(href).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
      if (yt) { h += `<div class="lf-card lf-video np-lfvideo" data-yt="${yt[1]}"><button type="button" class="lf-thumb lf-thumb-btn"><img src="${esc(src || `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`)}" alt=""><span class="lf-play">▶</span></button><div class="lf-player"></div><div class="lf-video-text"><div class="lf-card-meta">${esc(meta || 'Video · YouTube')}</div><a class="lf-card-title lf-ext" href="${esc(href)}" target="_blank" rel="noopener">${title} <span>↗</span></a><div class="lf-card-desc">${desc}</div><div class="lf-video-links"><button class="lf-close" type="button">Close</button></div></div></div>`; continue; }
      h += `<a class="lf-card" ${href ? linkAttrs(href) : 'href="#"'}><div class="lf-thumb">${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : ''}</div><div><div class="lf-card-meta">${esc(meta)}</div><div class="lf-card-title">${title} <span>${pg ? '→' : '↗'}</span></div><div class="lf-card-desc">${desc}</div></div></a>`; }
    return `<div class="lf-cards">${h}</div>`;
  }
  if (L === 'rules') return `<div class="lb-rules">${items.map(k => { const { name, rest } = splitBold(itemText(k)); return `<div><span>${esc(txt(name).trim())}</span>${esc(txt(rest).trim())}</div>`; }).join('')}</div>`;
  if (L === 'objects') {
    let h = '', n = 0; for (const k of kids.filter(k => k.type === 'toggle')) { const lab = txt(k.toggle.rich_text).trim(); const m = lab.match(/^([^:]+):\s*(.+)$/); const cat = m ? m[1] : '', title = m ? m[2] : lab; const ch = k.children || [];
      const im = ch.find(c => c.type === 'image'); const src = im ? await saveImg(im.image, im.id) : '';
      const ps = ch.filter(c => c.type === 'paragraph' && txt(c.paragraph.rich_text).trim()).map(c => { const t = txt(c.paragraph.rich_text).trim(); return /^tended\b/i.test(t) ? `<p class="lb-tend"><span>Tended</span> ${esc(t.replace(/^tended\s*:?\s*/i, ''))}</p>` : `<p>${rich(c.paragraph.rich_text, ctx)}</p>`; }).join('');
      h += `<article class="lb-item"><div class="mo-black lb-art">${src ? `<img src="${esc(src)}" alt="${esc(title)}" loading="lazy" class="sg-pop" style="width:100%;height:100%;object-fit:cover">` : ''}</div><div class="lb-meta"><span class="lb-n">${String(++n).padStart(2, '0')}</span><span class="lb-cat">${esc(cat)}</span></div><h3>${esc(title)}</h3>${ps}</article>`; }
    return `<div class="lb-grid">${h}</div>`;
  }
  if (L === 'captioned gallery') {
    let h = ''; for (const k of kids) if (k.type === 'image') { const src = await saveImg(k.image, k.id); if (src) h += `<figure><img class="sg-pop" src="${esc(src)}" alt="${esc(txt(k.image.caption))}" loading="lazy"><figcaption>${esc(txt(k.image.caption))}</figcaption></figure>`; }
    return `<div class="bm-gallery">${h}</div>`;
  }
  return null;
}
const NAMED_WIDE = /class="(ws-cards|ws-steps|ws-tools|ws-shop|pt-groups|pt-favs|lf-cards|lb-rules|lb-grid|bm-gallery)/;

async function toggle(b, ctx) {
  const label = txt(b.toggle.rich_text).trim(); const kids = b.children || [];
  if (/^slideshow$/i.test(label)) {
    const imgs = []; for (const k of kids) if (k.type === 'image') { const src = await saveImg(k.image, k.id); if (src) imgs.push({ src, cap: txt(k.image.caption) }); }
    return `<div class="mo-car" data-car><div class="mo-black mo-car-stage">${imgs.map((m, i) => `<div class="mo-slide${i ? '' : ' active'}"><img src="${esc(m.src)}" alt="${esc(m.cap)}" loading="lazy"></div>`).join('')}<button class="mo-car-prev" aria-label="Previous">‹</button><button class="mo-car-next" aria-label="Next">›</button></div><ol class="mo-car-caps">${imgs.map((m, i) => `<li${i ? '' : ' class="active"'}>${esc(m.cap)}</li>`).join('')}</ol></div>`;
  }
  if (/^gallery$/i.test(label)) {
    const imgs = []; for (const k of kids) if (k.type === 'image') { const src = await saveImg(k.image, k.id); if (src) imgs.push({ src, cap: txt(k.image.caption) }); }
    return `<div class="sg-gal">${imgs.map(m => `<img class="sg-gal-img sg-pop" src="${esc(m.src)}" alt="${esc(m.cap)}" loading="lazy">`).join('')}</div>`;
  }
  if (/^timeline$/i.test(label)) {
    const tbl = kids.find(k => k.type === 'table'); const rows = (tbl?.children || []).map(r => r.table_row.cells);
    const data = (tbl?.table?.has_column_header ? rows.slice(1) : rows).filter(r => r.length >= 2);
    return `<div class="ic-wrap"><div class="ic-ctrl"><button type="button" class="ic-prev" aria-label="Earlier">←</button><button type="button" class="ic-next" aria-label="Later">→</button></div><div class="ic-time">${data.map((r, k) => `<button type="button" class="ic-tick${k ? '' : ' on'}" data-i="${k}"><span class="ic-y">${esc(txt(r[0]))}</span><span class="ic-t">${esc(txt(r[1]))}</span></button>`).join('')}</div><div class="ic-detail">${data.map((r, k) => `<p class="ic-d${k ? '' : ' on'}" data-i="${k}"><strong>${esc(txt(r[0]))}.</strong> ${para(r[2] || r[1], ctx)}</p>`).join('')}</div></div>`;
  }
  const named = await namedToggle(label, kids, ctx); if (named !== null) return named;
  if (/^tabs$/i.test(label)) {
    const tabs = kids.filter(k => k.type === 'toggle');
    const panes = []; for (const t of tabs) panes.push(await html(t.children || [], ctx));
    return `<div class="mo-tabs" data-tabs><div class="mo-tabbar">${tabs.map((t, i) => `<button${i ? '' : ' class="active"'} data-t="${i}">${esc(txt(t.toggle.rich_text))}</button>`).join('')}</div>${panes.map((p, i) => `<div class="mo-tab${i ? '' : ' active'}">${p}</div>`).join('')}</div>`;
  }
  if (/^(\d{4})$/.test(label)) {
    const items = kids.filter(k => /list_item/.test(k.type));
    return `<div class="lu"><section class="lu-year"><button type="button" class="lu-yhead" aria-expanded="false"><span class="lu-y">${esc(label)}</span><span class="lu-count">${items.length} update${items.length === 1 ? '' : 's'}</span><span class="lu-tog">+</span></button><ul class="lu-list">${items.map(x => `<li>${para(x[x.type].rich_text, ctx)}</li>`).join('')}</ul></section></div>`;
  }
  const specimen = label.match(/^specimen\s*:?\s*(.*)$/i);
  if (specimen) {
    const im = kids.find(k => k.type === 'image'); const src = im ? await saveImg(im.image, im.id) : '';
    const tbl = kids.find(k => k.type === 'table'); const rows = (tbl?.children || []).map(r => r.table_row.cells);
    return `<article class="ed-card"><div class="ed-card-photo">${src ? `<img src="${esc(src)}" alt="" class="sg-pop">` : ''}<span class="ed-card-no">${esc(specimen[1] || '')}</span></div><dl>${rows.map(r => `<dt>${esc(txt(r[0]))}</dt><dd>${rich(r[1] || [], ctx)}</dd>`).join('')}</dl></article>`;
  }
  const flip = label.match(/^flip card\s*:?\s*(.*)$/i);
  if (flip) {
    const im = kids.find(k => k.type === 'image'); const src = im ? await saveImg(im.image, im.id) : '';
    const words = kids.filter(k => k.type === 'paragraph').map(k => `<p>${rich(k.paragraph.rich_text, ctx)}</p>`).join('');
    return `<div class="wh-flip" tabindex="0"><div class="wh-flip-in"><div class="wh-face"><h5>${esc(flip[1])}</h5>${words}<span class="ed-mono">Tap to turn</span></div><div class="wh-face wh-back">${src ? `<img src="${esc(src)}" alt="">` : ''}</div></div></div>`;
  }
  return `<details class="sg-acc"><summary>${rich(b.toggle.rich_text, ctx)}</summary>${await html(kids, ctx)}</details>`;
}

async function callout(b, ctx) {
  const v = b.callout, icon = v.icon?.emoji || '';
  const ls = lines(v.rich_text);
  if (icon === '📊') return `<div class="cs-stats">${ls.map(([n, ...rest]) => `<div><span class="cs-num">${esc(n.plain_text.trim())}</span><span class="cs-lab">${rich(rest, ctx)}</span></div>`).join('')}</div>`;
  if (icon === '📈') return ls.map(l => { const s = txt(l); const m = s.match(/^(.*?)(\d{1,3})\s*%\s*$/); if (!m) return ''; const p = Math.min(100, +m[2]); return `<div class="sg-row np-progress"><span>${esc(m[1].trim())}</span><span class="ab-bar"><span style="width:${p}%"></span></span><span class="ab-pct">${p}%</span></div>`; }).join('');
  if (icon === '🔤') { const ls = lines(v.rich_text); return `<div class="bm-specimen"><p class="bm-serif">${rich(ls[0] || [], ctx)}</p>${ls[1] ? `<p class="bm-label">${rich(ls[1], ctx)}</p>` : ''}</div>`; }
  if (icon === '🎨' && lines(v.rich_text).length > 1) {
    // one swatch per line: a name and a hex, like Canopy #2a5934
    return `<div class="bm-swatches">${lines(v.rich_text).map(l => { const t = txt(l).trim(); const m = t.match(/^(.*?)\s*(#[0-9a-f]{3,6})\b/i); if (!m) return ''; return `<div class="bm-swatch"><div style="background:${m[2]}"></div><span>${esc(m[1])}</span><span class="bm-hex">${m[2]}</span></div>`; }).join('')}</div>`;
  }
  if (icon === '🎨') { const hexes = txt(v.rich_text).match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []; return `<div class="sg-swatches">${hexes.map(h => `<span style="background:${h}" title="${h}"></span>`).join('')}</div>`; }
  if (icon === '🧵') return `<div class="af-weave"></div>`;
  const inner = rich(v.rich_text, ctx) + (b.children ? await html(b.children, ctx) : '');
  return `<div class="sg-callout">${cites(inner, ctx)}</div>`;
}

async function table(b, ctx, title) {
  const v = b.table, rows = (b.children || []).map(r => r.table_row.cells);
  const head = title ? `<div class="lf-box-title">${title}</div>` : '';
  if (v.has_column_header) return `<div class="lf-box">${head}<div class="lf-table-wrap"><table class="lf-table"><thead><tr>${rows[0].map(c => `<th>${rich(c, ctx)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${para(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  const cls = v.has_row_header ? 'lf-box lf-hover' : 'lf-box lf-plain';
  const chip = r => { const m = txt(r[1] || []).trim().match(/^(#[0-9a-f]{6}|#[0-9a-f]{3})\b/i); return m ? `<span class="bm-chip" style="background:${m[1]}"></span>` : ''; };
  return `<div class="${cls}">${head}<table>${rows.map(r => `<tr><th${r[0].length && r[0].every(x => x.annotations?.color === 'gray') ? ' class="lf-muted-th"' : ''}>${chip(r)}${rich(r[0], ctx)}</th>${r.slice(1).map(c => `<td>${para(c, ctx)}</td>`).join('')}</tr>`).join('')}</table></div>`;
}

const boldOnly = b => b.type === 'paragraph' && b.paragraph.rich_text.length && b.paragraph.rich_text.every(r => r.annotations?.bold) && !b.paragraph.rich_text.some(r => r.href);

// Render a list of blocks into units: { html, notes, wide }. wide = full-width piece (images, slides) that ends a side-note row.
async function units(blocks, ctx) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], t = b.type, v = b[t] || {};
    const push = (h, extra = {}) => { if (h) out.push({ html: h, notes: [], ...extra }); };
    if (t === 'bulleted_list_item' || t === 'numbered_list_item' || t === 'to_do') {
      const run = [b]; while (blocks[i + 1] && blocks[i + 1].type === t) run.push(blocks[++i]);
      const notes = []; run.forEach(x => notes.push(...splitKids(x.children).notes));
      if (ctx.sec === 'sources' && t === 'numbered_list_item') { push(`<ol class="lf-sources">${run.map(x => sourceItem(x, ++ctx.srcN, ctx)).join('')}</ol>`); continue; }
      if (ctx.sec === 'ingredients' && t === 'bulleted_list_item') {
        const base = ctx.serves || 0;
        const yieldBar = base && !ctx.yieldShown ? `<div class="rc-yield"><span>Serves</span>${[1, 2, 3].map(k => `<button${k === 1 ? ' class="active"' : ''} data-mult="${k}">${base * k}</button>`).join('')}</div>` : '';
        ctx.yieldShown = true;
        push(`${yieldBar}<ul class="rc-ing">${run.map(ingredient).join('')}</ul>`); continue;
      }
      const boldStart = x => x[t].rich_text?.[0]?.annotations?.bold;
      const item = async x => { const { kids } = splitKids(x.children); return para(x[t].rich_text, ctx) + (kids.length ? await html(kids, ctx) : ''); };
      if (t === 'numbered_list_item' && run.every(boldStart)) {
        if (ctx.sec === 'method') { const start = ctx.step + 1; ctx.step += run.length; out.push({ html: `<ol class="rc-steps"${start > 1 ? ` start="${start}"` : ''}>${(await Promise.all(run.map(async x => `<li>${await item(x)}</li>`))).join('')}</ol>`, notes }); continue; }
        // badge, then the bold words and the plain words on the same line
        let h = ''; for (const x of run) { const { kids } = splitKids(x.children); h += `<div class="lf-step np-step"><span class="lf-step-n">${++ctx.stepBadge}</span><p>${para(x[t].rich_text, ctx).replace(/<\/strong>(\S)/, '</strong> $1')}</p></div>${kids.length ? await html(kids, ctx) : ''}`; }
        out.push({ html: h, notes }); continue;
      }
      if (t === 'bulleted_list_item' && run.every(x => boldStart(x) && (/:\s*$/.test(x[t].rich_text[0].plain_text) || x[t].rich_text[1]?.plain_text?.startsWith(':')))) {
        if (!ctx.preview) run.forEach(x => { const [first, ...rest] = x[t].rich_text; const term = first.plain_text.replace(/:\s*$/, '').trim(), def = txt(rest).replace(/^:\s*/, '').trim(); if (term && def) HINTS.push({ term, definition: def, page: ctx.slug || '' }); });
        out.push({ html: `<dl class="sg-dl">${run.map(x => { const [first, ...rest] = x[t].rich_text; return `<dt>${esc(first.plain_text.replace(/:\s*$/, ''))}</dt><dd>${para(rest, ctx).replace(/^:\s*/, '')}</dd>`; }).join('')}</dl>`, notes }); continue;
      }
      if (ctx.sec === 'notes' && t === 'bulleted_list_item') { out.push({ html: `<ul class="rc-notes">${(await Promise.all(run.map(async x => `<li>${await item(x)}</li>`))).join('')}</ul>`, notes }); continue; }
      const tag = t === 'numbered_list_item' ? 'ol' : 'ul';
      const lis = await Promise.all(run.map(async x => `<li>${t === 'to_do' ? `<span class="np-box${x.to_do.checked ? ' on' : ''}"></span>` : ''}${await item(x)}</li>`));
      out.push({ html: `<${tag} class="lf-list${t === 'to_do' ? ' np-check' : ''}">${lis.join('')}</${tag}>`, notes }); continue;
    }
    switch (t) {
      case 'paragraph': {
        const { kids, notes } = splitKids(b.children);
        // a whole line colored gray (block color) = muted line, same as gray words
        const rt = v.color === 'gray' ? v.rich_text.map(r => ({ ...r, annotations: { ...(r.annotations || {}), color: 'gray' } })) : v.rich_text;
        if (!rt.length && !kids.length) { if (notes.length) out.push({ html: '', notes }); break; }
        // a bold-only line right above a table is that table's title
        if (boldOnly(b) && blocks[i + 1]?.type === 'table') { out.push({ html: await table(blocks[++i], ctx, esc(txt(rt))), notes, wide: false }); break; }
        // a line that is only a bold link is a button
        // a line that is only bold links = buttons (bold + italic = the outlined second button)
        const filled = rt.filter(r => r.plain_text.trim());
        if (filled.length && filled.every(r => (r.href || r.type === 'mention') && r.annotations?.bold)) {
          const groups = []; for (const r of filled) { const k = r.href || r.plain_text; const g = groups[groups.length - 1]; if (g && g.k === k && r.href) g.runs.push(r); else groups.push({ k, runs: [r] }); }
          const btn = g => {
            const f0 = g.runs[0], href = f0.href || '', mid = f0.type === 'mention' && ['page', 'database'].includes(f0.mention?.type) ? idOf(f0.mention[f0.mention.type].id) : '';
            const slug = mid ? sitePage(mid) : siteHref(href), label = esc(txt(g.runs).trim()), cls = `sg-btn${f0.annotations?.italic ? ' ghost' : ''}`;
            return slug ? `<a href="#" data-page="${esc(slug)}" class="${cls}">${label}</a>` : `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
          };
          out.push({ html: groups.length > 1 ? `<div class="sg-row np-btns">${groups.map(btn).join('')}</div>` : `<p>${btn(groups[0])}</p>`, notes }); break;
        }
        // a gray line in a guide card that starts with Base: or Recipe by
        const plainTxt = txt(rt).trim();
        // [Colors and type] (or [coded part]) marks where a page's coded part goes
        if (ctx.plain && /^\[(colors and type|coded part)\]$/i.test(plainTxt)) { push('<div data-keep-slot></div>'); break; }
        // a line that starts with h5: or h6: becomes that small heading
        const hx = plainTxt.match(/^h([56])\s*:\s*/i);
        if (hx) { const r2 = rt.map(r => ({ ...r })); let cut = hx[0].length; for (const r of r2) { const k = Math.min(cut, r.plain_text.length); r.plain_text = r.plain_text.slice(k); cut -= k; if (!cut) break; } push(`<h${hx[1]} class="sg-h">${rich(r2.filter(r => r.plain_text), ctx)}</h${hx[1]}>`); break; }
        if (ctx.inCard && /^base\s*:/i.test(plainTxt)) { ctx.card.base = plainTxt.replace(/^base\s*:\s*/i, ''); break; }
        if (ctx.inCard && /^(recipe by|source:|via)\b/i.test(plainTxt)) { out.push({ html: `<p class="fj-src">${rich(rt, ctx)}</p>`, notes }); break; }
        // Guide pages: a plain line is the large lead text; a gray line is the small tip under a section
        const pcls = ctx.template === 'Guide' && !ctx.inCard ? (rt.every(r => r.annotations?.color === 'gray') ? ' class="pt-tip"' : ' class="ws-lead"') : '';
        out.push({ html: (rt.length ? `<p${pcls}>${para(rt, ctx)}</p>` : '') + (kids.length ? await html(kids, ctx) : ''), notes }); break;
      }
      case 'heading_1': case 'heading_2': case 'heading_3': case 'heading_4': {
        // Notion Heading 2, 3, 4 = site Heading 2, 3, 4 (Heading 1 starts a section). h5: and h6: lines add 5 and 6.
        // On plain pages (case studies, Changelog, Colophon...) Heading 1 and 2 are both the page's section headings.
        const lvl = { heading_1: 2, heading_2: 2, heading_3: 3, heading_4: 4 }[t];
        const hid = (ctx.anchors || {})[idOf(b.id)] || (ctx.plain ? slugify(txt(v.rich_text)) : '');
        push(`<h${lvl}${ctx.plain ? '' : ' class="sg-h"'}${hid ? ` id="${hid}"` : ''}>${rich(v.rich_text, ctx)}</h${lvl}>`);
        if (b.children) push(await html(b.children, ctx)); break;
      }
      case 'quote': {
        const ls = lines(v.rich_text); let cite = '';
        if (ls.length > 1 && /^~\s*/.test(txt(ls[ls.length - 1]))) cite = txt(ls.pop()).replace(/^~\s*/, '');
        const body = ls.map(l => rich(l, ctx)).join('<br>'); const pull = /^["“]/.test(txt(ls[0] || []));
        push(`<blockquote class="${pull ? 'wk-quote' : 'sg-bq'}">${cites(body, ctx)}${cite ? `<cite>${esc(cite)}</cite>` : ''}</blockquote>`); break;
      }
      case 'callout': push(await callout(b, ctx)); break;
      case 'divider': push('<div class="lf-divider"></div>'); break;
      case 'code': push(`<pre class="sg-code"><code>${esc(txt(v.rich_text))}</code></pre><button type="button" class="sg-copy site-link">Copy code <span>⧉</span></button>`); break;
      case 'image': {
        if (b._hover) break;
        // images in a guide card collect into the card's example strip
        if (ctx.inCard) { const src = await saveImg(v, b.id); if (src) ctx.card.photos.push({ src, cap: txt(v.caption) }); break; }
        push(await figure(b, ctx), { wide: true }); break;
      }
      case 'column_list': {
        const cols = []; for (const c of b.children || []) cols.push(await html(c.children || [], ctx));
        push(`<div class="np-cols" style="--n:${cols.length}">${cols.map(c => `<div>${c}</div>`).join('')}</div>`, { wide: true }); break;
      }
      case 'toggle': {
        // several Specimen toggles in a row sit side by side
        if (/^specimen\b/i.test(txt(v.rich_text).trim())) {
          const run = [b]; while (blocks[i + 1]?.type === 'toggle' && /^specimen\b/i.test(txt(blocks[i + 1].toggle.rich_text).trim())) run.push(blocks[++i]);
          let h = ''; for (const x of run) h += await toggle(x, ctx); push(`<div class="ed-page np-ed"><div class="ed-cards">${h}</div></div>`, { wide: true }); break;
        }
        const h = await toggle(b, ctx); push(h, { wide: /class="(mo-car|sg-gal|ic-wrap|mo-tabs)/.test(h) || NAMED_WIDE.test(h) }); break;
      }
      case 'table': {
        if (ctx.inCard && !v.has_column_header) { const rows = (b.children || []).map(r => r.table_row.cells); ctx.card.settings = `<div class="lf-box lf-plain fj-set"><table>${rows.map(r => `<tr><th>${rich(r[0], ctx)}</th>${r.slice(1).map(c => `<td>${rich(c, ctx)}</td>`).join('')}</tr>`).join('')}</table></div>`; break; }
        push(await table(b, ctx), { wide: true }); break;
      }
      case 'video': {
        const url = fileUrl(v), cap = txt(v.caption);
        if (videoCard(url, cap, push)) break;
        // a video file uploaded to Notion: saved with the site and played right on the page
        if (v.type === 'file' || v.type === 'file_upload') { const src = await saveFile(url, 'files', idOf(b.id)); if (src) push(`<figure class="lf-figure np-vfile"><video src="${esc(src)}" controls playsinline preload="metadata"></video>${cap ? `<figcaption><span>${esc(cap)}</span></figcaption>` : ''}</figure>`, { wide: true }); break; }
        if (url) push(`<a class="np-linkcard" href="${esc(url)}" target="_blank" rel="noopener"><b>${esc(cap || url)}</b><span>${esc(url.replace(/^https?:\/\//, '').split('/')[0])} ↗</span></a>`);
        break;
      }
      case 'audio': {
        const src = await saveFile(fileUrl(v), 'files', idOf(b.id)); const cap = txt(v.caption) || 'Recording';
        if (src) push(`<div class="lb-tracks"><div class="lb-track np-audio"><button type="button" class="lb-play" aria-label="Play">▶</button><div class="lb-tinfo"><div class="lb-tt">${esc(cap)}</div><div class="lb-wave">${Array.from({ length: 30 }, (_, k) => `<i style="height:${6 + ((k * 37) % 23)}px"></i>`).join('')}</div><div class="lb-ts">Tap to play</div></div><audio preload="none" src="${esc(src)}"></audio></div></div>`);
        break;
      }
      case 'bookmark': case 'embed': case 'link_preview': {
        const url = v.url || ''; const cap = txt(v.caption);
        if (videoCard(url, cap, push)) break;
        const form = formUrl(url);
        if (form) { push(`<div class="np-form"><iframe src="${esc(form)}" title="${esc(cap || 'Form')}" loading="lazy"></iframe></div>`, { wide: true }); break; }
        if (url) push(`<a class="np-linkcard" href="${esc(url)}" target="_blank" rel="noopener"><b>${esc(cap || url.replace(/^https?:\/\//, ''))}</b><span>${esc(url.replace(/^https?:\/\//, '').split('/')[0])} ↗</span></a>`); break;
      }
      case 'synced_block': if (b.children) push(await html(b.children, ctx)); break;
      case 'tab': {
        // Notion's own /tabs block: each item is a tab, what is under it is the panel
        const items = (b.children || []).filter(k => k.type === 'paragraph' || k.type === 'heading_3' || k.type === 'toggle');
        const panes = []; for (const k of items) panes.push(await html(k.children || [], ctx));
        push(`<div class="mo-tabs" data-tabs><div class="mo-tabbar">${items.map((k, j) => `<button${j ? '' : ' class="active"'} data-t="${j}">${esc(txt(k[k.type].rich_text))}</button>`).join('')}</div>${panes.map((h, j) => `<div class="mo-tab${j ? '' : ' active'}">${h}</div>`).join('')}</div>`, { wide: true }); break;
      }
      case 'file': case 'pdf': {
        const name = v.name || txt(v.caption) || 'Download';
        const src = await saveFile(fileUrl(v), 'files', slugify(name) || idOf(b.id));
        if (src) push(`<p><a href="${esc(src)}" class="cv-download site-link" download>${esc(txt(v.caption) || name)} <span>${ARROW_DL}</span></a></p>`); break;
      }
      default: SKIPPED.add(t); break;
    }
  }
  return out;
}
// Plain rendering (no side-note column): side notes show as callout boxes under their block
async function html(blocks, ctx) {
  return (await units(blocks, ctx)).map(u => u.html + u.notes.map(n => `<div class="sg-callout">${rich(n.callout.rich_text, ctx)}</div>`).join('')).join('');
}
// Side-note layout (Essay and Recipe): text on the left, notes in the margin; full-width pieces break the rows
function rows(list, ctx) {
  let out = '', text = '', side = '';
  const flush = () => { if (text || side) out += `<div class="mo-row"><div class="mo-text">${text}</div><div class="mo-side">${side}</div></div>`; text = side = ''; };
  for (const u of list) {
    if (u.wide) { flush(); out += u.html; continue; }
    if (u.notes.length && text) flush();
    text += u.html;
    side += u.notes.map(n => `<p class="mo-sn"><span>${String.fromCharCode(97 + (ctx.letter++ % 26))}</span> ${cites(rich(n.callout.rich_text, ctx), ctx)}</p>`).join('');
  }
  flush(); return out;
}

// Split the page at each Heading 1 and lay it out for its template
async function layout(blocks, ctx) {
  // anchors for "jump down the page" links: heading blocks get ids
  const used = new Set();
  const mk = label => { let id = `${ctx.slug}-${slugify(label) || 's'}`; let k = 2; while (used.has(id)) id = `${ctx.slug}-${slugify(label)}-${k++}`; used.add(id); return id; };
  ctx.anchors = {};
  const sections = [{ title: '', id: `${ctx.slug}-top`, blocks: [] }];
  for (const b of blocks) {
    if (b.type === 'heading_1') { const title = txt(b.heading_1.rich_text).trim(); const id = mk(title); ctx.anchors[idOf(b.id)] = id; sections.push({ title, id, blocks: [] }); }
    else { if (/^heading_[234]$/.test(b.type)) ctx.anchors[idOf(b.id)] = mk(txt(b[b.type].rich_text)); sections[sections.length - 1].blocks.push(b); }
  }
  const T = ctx.template; let out = ''; const nav = [];
  for (const s of sections) {
    const key = s.title.toLowerCase();
    ctx.sec = /^sources$/.test(key) ? 'sources' : /^ingredients$/.test(key) ? 'ingredients' : /^method$/.test(key) ? 'method' : /^notes$/.test(key) ? 'notes' : '';
    if (T !== 'Recipe' && ctx.sec !== 'sources') ctx.sec = '';
    if (!s.title && !s.blocks.length) continue;
    if (ctx.sec === 'sources') {
      const list = await html(s.blocks, ctx);
      out += T === 'Long read' ? `<div class="lf-divider"></div><section class="lf-section np-sec" data-toc="Sources" id="${s.id}"><h3 class="lf-src-head">Sources</h3>${list}</section>`
        : `<div class="lf-divider"></div><section class="mo-sources np-sec" data-toc="Sources" id="${s.id}"><h3 class="lf-src-head">Sources</h3>${list}</section>`;
      if (T === 'Recipe') nav.push({ id: s.id, label: 'Sources', color: '' });
      continue;
    }
    if (T === 'Long read') {
      out += `<section class="lf-section np-sec" data-toc="${esc(s.title || ctx.title)}" id="${s.id}">${s.title ? `<h3 class="lf-h">${esc(s.title)}</h3>` : ''}${await html(s.blocks, ctx)}</section>`;
    } else if (T === 'Guide') {
      // Heading 2 inside a guide section = one card (like each film simulation recipe)
      let h = '', cards = []; let i = 0; const bl = s.blocks;
      const pre = []; while (i < bl.length && bl[i].type !== 'heading_2') pre.push(bl[i++]);
      h += await html(pre, ctx);
      while (i < bl.length) {
        const head = bl[i++]; const body = []; while (i < bl.length && bl[i].type !== 'heading_2') body.push(bl[i++]);
        ctx.inCard = true; ctx.card = { photos: [], base: '', settings: '' };
        const inner = await html(body, ctx); const card = ctx.card; ctx.inCard = false;
        const n = String(cards.length + 1).padStart(2, '0'); const title = txt(head.heading_2.rich_text).trim(); const cid = ctx.anchors[idOf(head.id)];
        cards.push({ n, title, cid });
        h += `<article class="fj-rec" id="${cid}" data-toc="${esc(title)}"><div class="fj-head"><span class="fj-n">${n}</span><h3>${esc(title)}</h3>${card.base ? `<span class="fj-base">${esc(card.base)}</span>` : ''}</div><div class="fj-body">${card.photos.length ? `<div class="fj-ex">${card.photos.map(p => `<img class="sg-pop" src="${esc(p.src)}" alt="${esc(p.cap)}" loading="lazy" style="width:100%;aspect-ratio:3 / 2;object-fit:cover;border-radius:10px">`).join('')}</div>` : ''}${card.settings}${inner}</div></article>`;
      }
      const index = cards.length > 1 ? `<div class="fj-index">${cards.map(c => `<a href="#${c.cid}" class="fj-chip" data-jump="${c.cid}"><span>${c.n}</span>${esc(c.title)}</a>`).join('')}</div>` : '';
      if (index) h = h.replace(/(<article class="fj-rec")/, index + '$1');
      out += `<section class="ws-sec np-sec" id="${s.id}"${s.title ? ` data-toc="${esc(s.title)}"` : ''}>${s.title ? `<h2 class="ws-h">${esc(s.title)}</h2>` : ''}${h}</section>`;
    } else if (T === 'Collection') {
      out += `${s.title ? `<h2 class="mo-h">${esc(s.title)}</h2>` : ''}${await html(s.blocks, ctx)}`;
    } else {
      // Essay and Recipe: the Fonio layout, with side notes in the margin
      const color = T === 'Recipe' ? SEC_COLORS[key] || '' : '';
      const list = await units(s.blocks, ctx);
      if (!s.title) { out += `<section class="mo-sec np-sec np-intro" id="${s.id}">${rows(list, ctx)}</section>`; continue; }
      out += `<section class="mo-sec np-sec" id="${s.id}" data-toc="${esc(s.title)}"${color ? ` style="--c:${color}"` : ''}><h2 class="mo-h">${esc(s.title)}</h2>${rows(list, ctx)}</section>`;
      nav.push({ id: s.id, label: s.title, color });
    }
  }
  return { html: out, nav };
}

const pieces = [];
for (const p of pieceRows) {
  const pr = p.properties; const id = idOf(p.id);
  const slug = slugById[id];
  const template = pr.Template?.select?.name || ((pr.Tags?.multi_select || []).some(t => t.name === 'recipe') ? 'Recipe' : 'Essay');
  const ctx = { slug, template, preview: !check(pr.Publish), title: plain(pr.Title), images: [], serves: pr.Serves?.number || 0, srcN: 0, step: 0, stepBadge: 0, letter: 0 };
  let body = { html: '', nav: [] };
  try { const bl = await children(p.id); await collectHovers(bl, ctx, id); body = await layout(bl, ctx); } catch (e) { console.warn(`Skipped body of ${slug}: ${e.message}`); }
  const words = body.html.replace(/<template[\s\S]*?<\/template>/g, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const items = guideRows.filter(g => g.pageIds.includes(id)).sort((a, b) => a.order - b.order).map(({ pageIds, ...g }) => g);
  pieces.push({
    slug, template, title: plain(pr.Title), section: pr.Section?.select?.name || 'Vibe Projects', zone: pr.Zone?.select?.name || '',
    tags: (pr.Tags?.multi_select || []).map(t => t.name), dek: plain(pr.Dek), sideLine: plain(pr['Side line']), meta: plain(pr['Meta note']),
    date: pr.Date?.date?.start || '', ai: check(pr['AI drafted']), readTime: pr['Read time (min)']?.number || Math.max(1, Math.ceil(words / 230)),
    sources: ctx.srcN, replace: check(pr['Replace built page']), preview: !check(pr.Publish), serves: pr.Serves?.number || null, time: plain(pr['Total time']),
    order: pr.Order?.number ?? 999, about: plain(pr['About this piece']), next: plain(pr["What's next"]), thanks: plain(pr.Acknowledgments),
    html: body.html, nav: body.nav, items,
  });
}

pieces.sort((a, b) => a.order - b.order || (b.date || '').localeCompare(a.date || ''));


// ---------- everything else on the site ----------
// Each part is separate: if one database is not shared with the integration, the rest still sync.
const extra = {};
async function part(name, fn) { try { extra[name] = await fn(); } catch (e) { console.warn(`Skipped ${name}: ${e.message}`); } }
const num = p => p?.number ?? null;
const sel = p => p?.select?.name || '';
const url = p => p?.url || '';
const ord = (a, b) => (a.order ?? 999) - (b.order ?? 999);
// rich text -> small HTML (bold, italic, code, highlight, links). The site restyles links to match.
function inl(rt) {
  let out = '', i = 0; rt = rt || [];
  while (i < rt.length) {
    const href = rt[i].href || rt[i].text?.link?.url || ''; let chunk = '';
    while (i < rt.length && (rt[i].href || rt[i].text?.link?.url || '') === href) {
      const t = rt[i]; const a = t.annotations || {}; let h = esc(t.plain_text).replace(/\n/g, '<br>');
      if (a.code) h = `<code>${h}</code>`; if (a.bold) h = `<strong>${h}</strong>`; if (a.italic) h = `<em>${h}</em>`;
      if (a.strikethrough) h = `<s>${h}</s>`; if (a.underline) h = `<u>${h}</u>`; if (a.color === 'yellow_background') h = `<mark>${h}</mark>`;
      chunk += h; i++;
    }
    out += href ? `<a href="${esc(href)}">${chunk}</a>` : chunk;
  }
  return out;
}
const rtOf = p => p?.title || p?.rich_text || [];
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; adjoakittoe-site-sync)' };
async function getText(u) { try { const r = await fetch(u, { headers: UA, redirect: 'follow' }); return r.ok ? await r.text() : ''; } catch { return ''; } }
const meta = (h, k) => { const m = h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*>`, 'i')); const c = m && m[0].match(/content=["']([^"']*)["']/i); return c ? c[1].replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').trim() : ''; };
const ytId = u => (String(u).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/) || [])[1] || '';
const vimeoId = u => (String(u).match(/vimeo\.com\/(?:video\/)?(\d+)/) || [])[1] || '';

await part('text', async () => {
  const out = {};
  for (const p of await queryAll(DB.siteText)) {
    const key = plain(p.properties.Key); if (!key) continue; out[key] = { html: inl(rtOf(p.properties.Text)), text: plain(p.properties.Text) };
    if (p.properties.Photo?.files?.length) out[key].photo = await saveProp(p, p.properties.Photo, 'text');
  }
  return out;
});

await part('life', async () => (await queryAll(DB.life)).filter(p => check(p.properties.Publish)).map(p => { const pr = p.properties; return {
  text: plain(pr.Update), year: sel(pr.Year), group: plain(pr.Group), link: url(pr.Link), words: plain(pr['Link words']), link2: url(pr['Link 2']), words2: plain(pr['Link 2 words']), arrow: check(pr['Arrow link']), order: num(pr.Order) }; }).sort(ord));

await part('published', async () => (await queryAll(DB.published)).filter(p => check(p.properties.Publish)).map(p => { const pr = p.properties; return {
  title: plain(pr.Title), section: sel(pr.Section), link: url(pr.Link), sub: plain(pr.Subtitle), note: plain(pr.Note), extra: url(pr['Extra link']), extraWords: plain(pr['Extra link words']), order: num(pr.Order) }; }).sort(ord));

await part('stack', async () => (await queryAll(DB.stack)).filter(p => check(p.properties.Publish)).map(p => { const pr = p.properties; return {
  name: plain(pr.Name), description: plain(pr.Description), cost: sel(pr.Cost), color: plain(pr['Icon color']), link: url(pr.Link), order: num(pr.Order) }; })
  .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name)));

await part('bookmarks', async () => (await queryAll(DB.bookmarks)).filter(p => check(p.properties.Publish)).map(p => { const pr = p.properties; return {
  title: plain(pr.Title), tab: sel(pr.Tab), link: url(pr.Link), tags: (pr.Tags?.multi_select || []).map(t => t.name), date: plain(pr.Date), note: plain(pr.Note), color: sel(pr.Color), order: num(pr.Order) }; }).sort(ord));

await part('shelf', async () => {
  const items = [];
  for (const p of (await queryAll(DB.shelf)).filter(p => check(p.properties.Publish))) {
    const pr = p.properties;
    const it = { title: plain(pr.Title), type: sel(pr.Type), status: sel(pr.Status), creator: plain(pr.Creator), link: url(pr.Link), rating: num(pr.Rating), order: num(pr.Order), cover: '' };
    // Only the monthly playlist uses a real picture. Everything else gets the coded cover.
    if (it.type === 'Music' && it.status === 'Playlist') {
      it.cover = await saveProp(p, pr.Cover, 'shelf');
      if (it.link) {
        const h = await getText(it.link);
        if (h) {
          if (!it.title) it.title = meta(h, 'og:title');
          if (!it.creator) it.creator = meta(h, 'og:description').replace(/\s+/g, ' ').slice(0, 110);
          if (!it.cover) it.cover = await saveFile(meta(h, 'og:image'), 'shelf', 'og-' + p.id.replace(/-/g, ''), 900);
        }
      }
    } else if (it.type === 'Music' && it.link && !it.title) {
      const h = await getText(it.link); if (h) { it.title = meta(h, 'og:title'); if (!it.creator) it.creator = meta(h, 'og:description').replace(/\s+/g, ' ').slice(0, 110); }
    }
    if (it.title) items.push(it);
  }
  items.sort(ord);
  // Films logged in the Letterboxd diary. The feed only lists diary entries, so films you rate without logging a date will not appear.
  const films = [...savedFilms];
  const res = await fetch(`https://letterboxd.com/${LETTERBOXD}/rss/`, { headers: UA }).catch(e => ({ ok: false, status: e.message }));
  const rss = res.ok ? await res.text() : '';
  if (!res.ok) console.warn(`Letterboxd feed did not load (${res.status}). Keeping the films saved before.`);
  let fresh = 0;
  for (const m of rss.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1]; const tag = t => ((x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const title = tag('letterboxd:filmTitle'); if (!title) continue; fresh++;
    const f = { title, year: tag('letterboxd:filmYear'), rating: parseFloat(tag('letterboxd:memberRating')) || null, link: tag('link'), watched: tag('letterboxd:watchedDate') };
    const i = films.findIndex(g => g.title === f.title && g.year === f.year); if (i >= 0) films[i] = f; else films.push(f);
  }
  // Every film marked watched on Letterboxd (first page of the Films tab, newest first), with its stars
  const page = await fetch(`https://letterboxd.com/${LETTERBOXD}/films/`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', Accept: 'text/html' } }).then(r => r.ok ? r.text() : '').catch(() => '');
  let listed = 0;
  for (const m of page.matchAll(/<li class="griditem">([\s\S]*?)<\/li>/g)) {
    const x = m[1]; const nm = (x.match(/data-item-name="([^"]+)"/) || [])[1]; if (!nm) continue;
    const name = nm.replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"');
    const ty = name.match(/^(.*) \((\d{4})\)$/); const title = ty ? ty[1] : name, year = ty ? ty[2] : '';
    const r = (x.match(/rated-(\d+)/) || [])[1]; const link = 'https://letterboxd.com' + ((x.match(/data-item-link="([^"]+)"/) || [])[1] || '');
    listed++;
    const f = { title, year, rating: r ? +r / 2 : null, link, watched: '' };
    const i = films.findIndex(g => g.title === f.title && g.year === f.year); if (i >= 0) { if (f.rating != null) films[i].rating = f.rating; } else films.push(f);
  }
  if (!page) console.warn('Letterboxd films page did not load. Keeping the films saved before.');
  else console.log(`Letterboxd films page: ${listed} films.`);
  films.forEach(f => delete f.cover);
  // Books from Literal: reading now, finished, and your star ratings (public profile, no login needed)
  let books = savedBooks;
  try { books = await literalBooks(); console.log(`Literal: ${books.filter(b => b.status === 'Reading').length} reading, ${books.filter(b => b.status === 'Finished').length} finished.`); }
  catch (e) { console.warn(`Literal did not load (${e.message}). Keeping the books saved before.`); }
  films.sort((a, b) => (b.watched || '').localeCompare(a.watched || '')); // diary entries first, then the Films page order
  console.log(`Letterboxd: ${fresh} diary entries in the feed, ${films.length} films kept.`);
  return { items, films: films.slice(0, 72), books };
});

async function literalBooks() {
  const gql = async (query, variables) => {
    const r = await fetch('https://literal.club/graphql/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...UA }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw new Error('status ' + r.status); const j = await r.json(); if (j.errors) throw new Error(j.errors[0].message); return j.data;
  };
  const pid = (await gql('query($h:String!){profile(where:{handle:$h}){id}}', { h: LITERAL })).profile?.id; if (!pid) throw new Error('profile not found');
  const list = async st => { const out = []; for (let off = 0; off < 2000; off += 100) { const b = (await gql('query($p:String!,$s:ReadingStatus!,$o:Int!){booksByReadingStateAndProfile(limit:100,offset:$o,readingStatus:$s,profileId:$p){id slug title authors{name}}}', { p: pid, s: st, o: off })).booksByReadingStateAndProfile || []; out.push(...b); if (b.length < 100) break; } return out; };
  const rating = {};
  for (let off = 0; off < 5000; off += 100) { const l = (await gql('query($p:String!,$o:Int!){getUserReviews(profileId:$p,limit:100,offset:$o){... on BookReviewActivity{ data { rating bookId } }}}', { p: pid, o: off })).getUserReviews || []; l.forEach(x => { if (x?.data?.bookId && x.data.rating != null) rating[x.data.bookId] = x.data.rating; }); if (l.length < 100) break; }
  const shape = (b, status) => ({ title: b.title, creator: (b.authors || []).map(a => a.name).join(', '), link: `https://literal.club/book/${b.slug}`, rating: rating[b.id] ?? null, status });
  return [...(await list('IS_READING')).map(b => shape(b, 'Reading')), ...(await list('FINISHED')).map(b => shape(b, 'Finished'))];
}

await part('resume', async () => (await queryAll(DB.resume)).filter(p => check(p.properties.Publish)).map(p => p).reduce(async (accP, p) => {
  const acc = await accP; const pr = p.properties;
  acc.push({ title: plain(pr.Title), section: sel(pr.Section), date: plain(pr.Date), org: plain(pr.Org), link: url(pr.Link), photo: await saveProp(p, pr['Hover photo'], 'resume'), order: num(pr.Order) });
  return acc;
}, Promise.resolve([])).then(l => l.sort(ord)));

await part('about-lists', async () => {
  const out = [];
  for (const p of (await queryAll(DB.aboutLists)).filter(p => check(p.properties.Publish))) {
    const pr = p.properties;
    out.push({ item: plain(pr.Item), list: sel(pr.List), link: url(pr.Link), words: plain(pr['Link words']), photo: await saveProp(p, pr['Hover photo'], 'about'), dove: check(pr.Dove), note: plain(pr.Note),
      done: num(pr.Done), goal: num(pr.Goal), unit: plain(pr.Unit), text: plain(pr['Progress text']), states: check(pr['Use State Tracker']), order: num(pr.Order) });
  }
  return out.sort(ord);
});

await part('kitchen', async () => {
  const out = [];
  for (const p of (await queryAll(DB.kitchen)).filter(p => check(p.properties.Publish))) {
    const src = await saveProp(p, p.properties.Photo, 'kitchen'); if (src) out.push({ dish: plain(p.properties.Dish), src, order: num(p.properties.Order) });
  }
  return out.sort(ord);
});

// A Date with a time (Notion date picker, Include time) fills Time when Time is empty. Times show in New York time.
const NY = 'America/New_York';
const nyDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const nyTime = d => new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' }).format(new Date(d)).replace(':00', '').replace(/\u202f/g, ' ');
const evDay = s => !s ? '' : s.length > 10 ? nyDay(s) : s;
const evTime = (dt, typed) => { if (typed) return typed; const s = dt?.start || '', e = dt?.end || ''; if (s.length <= 10) return ''; const a = nyTime(s); if (e.length > 10) { const b = nyTime(e); return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a} – ${b}`; } return a; };
await part('events', async () => (await queryAll(DB.events)).filter(p => check(p.properties.Publish)).map(p => { const pr = p.properties; return {
  key: 'ev-' + slugify(plain(pr.Event)) + '-' + evDay(pr.Date?.date?.start), title: plain(pr.Event), start: evDay(pr.Date?.date?.start), end: evDay(pr.Date?.date?.end) === evDay(pr.Date?.date?.start) ? '' : evDay(pr.Date?.date?.end),
  label: plain(pr['Date label']), time: evTime(pr.Date?.date, plain(pr.Time)), detail: plain(pr.Detail), city: plain(pr.City), where: plain(pr.Where), host: plain(pr.Host), cost: plain(pr.Cost),
  format: sel(pr.Format), desc: plain(pr.Description), rsvp: url(pr['RSVP link']), rsvpSite: plain(pr['RSVP site']), link: url(pr.Link), linkWords: plain(pr['Link words']) }; }).filter(e => e.title && e.start));

await part('resources', async () => {
  const out = [];
  for (const p of (await queryAll(DB.resources)).filter(p => check(p.properties.Publish))) {
    const pr = p.properties; const vl = url(pr['Video link']);
    const yt = ytId(vl), vm = vimeoId(vl);
    const file = await saveProp(p, pr['Video file'], 'resources');
    out.push({ name: plain(pr.Name), category: sel(pr.Category), label: plain(pr.Label), description: plain(pr.Description), deadline: plain(pr.Deadline), link: url(pr.Link),
      groups: check(pr['Groups doing the work']), media: sel(pr['Media type']), order: num(pr.Order),
      video: yt ? `https://www.youtube.com/embed/${yt}?autoplay=1` : vm ? `https://player.vimeo.com/video/${vm}?autoplay=1` : file || vl,
      thumb: yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : '' });
  }
  return out.sort(ord);
});

await part('photography', async () => {
  const out = [];
  for (const p of (await queryAll(DB.photography)).filter(p => check(p.properties.Publish))) {
    const pr = p.properties; const title = plain(pr.Series); const id = p.id.replace(/-/g, '');
    const photos = [];
    // photos placed in the page body (with captions) come first, then the Photos property
    try { let k = 0; for (const b of await children(p.id)) if (b.type === 'image') { const src = await saveFile(fileUrl(b.image), 'photos', `${id}-b${k++}`); if (src) photos.push({ src, cap: (b.image.caption || []).map(t => t.plain_text).join('') }); } } catch {}
    let k = 0; for (const f of pr.Photos?.files || []) { const src = await saveFile(fileUrl(f), 'photos', `${id}-${k++}`); if (src) photos.push({ src, cap: '' }); }
    out.push({ title, subtitle: plain(pr.Subtitle), years: plain(pr.Years), medium: sel(pr.Medium), cats: (pr.Categories?.multi_select || []).map(c => c.name), description: plain(pr.Description), photos, order: num(pr.Order) });
  }
  return out.sort(ord);
});

await part('academia', async () => {
  const out = [];
  for (const p of (await queryAll(DB.academia)).filter(p => check(p.properties.Publish))) {
    const pr = p.properties; const file = await saveProp(p, pr.File, 'academia');
    out.push({ title: plain(pr.Title), type: sel(pr.Type), venue: plain(pr.Venue), year: plain(pr.Year), link: file || url(pr.Link), description: plain(pr.Description), order: num(pr.Order) });
  }
  return out.sort((a, b) => ord(a, b) || String(b.year).localeCompare(String(a.year)));
});

// Plain pages (case studies and Site Pages & Links): Notion body -> the same markup as the hand-built pages
async function plainPage(pageId, slug) {
  const bl = await children(pageId); if (!bl.length) return '';
  const ctx = { slug, template: 'Page', plain: true, title: '', images: [], srcN: 0, step: 0, stepBadge: 0, letter: 0, anchors: {} };
  await collectHovers(bl, ctx, idOf(pageId));
  return (await html(bl, ctx)).replace(/ class="np-in"/g, ' class="ab-link"').replace(/<(ul|ol) class="lf-list">/g, '<$1>');
}
const stat = l => { const s = l.trim(); if (!s) return null; const i = s.indexOf('|'); return i >= 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : [s.split(/\s+/)[0], s.split(/\s+/).slice(1).join(' ')]; };

await part('cases', async () => {
  const out = [];
  for (const p of caseRows.filter(p => check(p.properties.Publish))) {
    const pr = p.properties, slug = caseSlug(p);
    let body = ''; try { body = await plainPage(p.id, slug); } catch (e) { console.warn(`Skipped body of ${slug}: ${e.message}`); }
    const link = url(pr.Link), inPage = siteHref(link);
    out.push({ slug, org: plain(pr.Org), sub: plain(pr.Subtitle), ctx: plain(pr.Context), date: plain(pr.Dates),
      challenge: inl(rtOf(pr.Challenge)), solution: inl(rtOf(pr.Solution)), impact: inl(rtOf(pr.Impact)),
      statsLabel: sel(pr['Stats label']) || 'Results', stats: plain(pr.Stats).split('\n').map(stat).filter(Boolean),
      link: inPage ? '' : link, linkPage: inPage, linkWords: plain(pr['Link words']), note: plain(pr.Note),
      photo: await saveProp(p, pr['Hover photo'], 'hover'), button: plain(pr['Button words']) || 'View case study',
      title: plain(pr['Page title']) || [plain(pr.Org), plain(pr.Subtitle)].filter(Boolean).join(': '), subline: plain(pr['Page subline']),
      body, order: num(pr.Order) });
  }
  return out.sort(ord);
});

await part('site-pages', async () => {
  const out = [];
  for (const p of sitePageRows.filter(p => check(p.properties.Publish))) {
    const pr = p.properties, slug = slugById[idOf(p.id)]; if (!slug) continue;
    let body = ''; try { body = await plainPage(p.id, slug); } catch (e) { console.warn(`Skipped body of ${slug}: ${e.message}`); }
    // Changelog style: each heading is a date, with its list under it
    if (sel(pr.Style) === 'Changelog' && body) body = body.split(/(?=<h2[ >])/).map(part => /^<h2/.test(part) ? `<section class="cl-entry">${part.replace(/^<h2[^>]*>/, '<h2 class="cl-date">')}</section>` : part).join('');
    const link = url(pr.Link), inPage = siteHref(link);
    out.push({ slug, title: plain(pr.Title), sub: plain(pr.Subtitle), style: sel(pr.Style) || 'Page', replace: check(pr['Replace built page']),
      menu: sel(pr.Menu), footer: sel(pr.Footer), link: inPage ? '' : link, linkPage: inPage, words: plain(pr['Link words']), hide: check(pr['Hide link']),
      body, order: num(pr.Order) });
  }
  return out.sort(ord);
});

await part('glossary', async () => {
  const list = (await queryAll(DB.glossary)).filter(p => check(p.properties.Publish)).map(p => { const pr = p.properties; return {
    term: plain(pr.Term), definition: inl(rtOf(pr.Definition)), also: plain(pr['Also matches']) }; }).filter(x => x.term);
  // Blue hover words from any published page join the glossary too (a Glossary row with the same term wins)
  const have = new Set(list.flatMap(x => [x.term, ...String(x.also || '').split(',')].map(k => k.trim().toLowerCase()).filter(Boolean)));
  for (const h of HINTS) { const k = h.term.toLowerCase(); if (have.has(k)) continue; have.add(k); list.push({ term: h.term.charAt(0).toUpperCase() + h.term.slice(1), definition: esc(h.definition), also: '', auto: true }); }
  return list.sort((a, b) => a.term.localeCompare(b.term));
});

await mkdir('data', { recursive: true });
const save = (f, d) => writeFile(`data/${f}`, JSON.stringify(d, null, 2) + '\n');
await Promise.all([save('notes.json', notes), save('states.json', states), save('pieces.json', pieces), save('projects.json', projects), save('seeds.json', seeds), save('hover.json', hover), ...Object.entries(extra).map(([k, v]) => save(`${k}.json`, v))]);
console.log(`Also saved: ${Object.keys(extra).join(', ')}.`);
if (SKIPPED.size) console.log(`Notion blocks the site skipped: ${[...SKIPPED].join(', ')}.`);
console.log(`Saved ${notes.length} notes, ${states.length} states, ${pieces.length} pages, ${projects.length} projects, ${seeds.length} seeds.`);
