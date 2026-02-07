import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";
import { getConfig, getCacheRedisConfig } from "@exams2quiz/shared/config";
import { Redis as IORedis } from "ioredis";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types for split JSON data ───────────────────────────────────
interface QuestionData {
  points: number;
  options: string[];
  question_text: string;
  question_type: string;
  correct_answer: string;
  question_number: string;
}

interface QuestionItem {
  file: string;
  success: boolean;
  data: QuestionData;
  categorization: {
    success: boolean;
    category: string;
    subcategory?: string;
    reasoning: string;
  };
  similarity_group_id: string | null;
}

interface SplitFile {
  category_name: string;
  subcategory_name?: string;
  groups: QuestionItem[][];
}

// ─── Cache client singleton ──────────────────────────────────────
let cacheRedis: IORedis | null = null;

function getCacheClient(): IORedis {
  if (!cacheRedis) {
    const cfg = getCacheRedisConfig();
    cacheRedis = new IORedis({
      host: cfg.host,
      port: cfg.port,
      password: cfg.password,
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });
    cacheRedis.on("error", (err: Error) => {
      console.error("[cache-redis] connection error:", err.message);
    });
  }
  return cacheRedis;
}

interface CacheEntry {
  html: string;
  cachedAt: number; // epoch ms
}

async function getCached(key: string): Promise<CacheEntry | null> {
  try {
    const raw = await getCacheClient().get(key);
    if (!raw) return null;
    // Support both new JSON format and legacy raw HTML
    if (raw.startsWith("{")) {
      return JSON.parse(raw) as CacheEntry;
    }
    return { html: raw, cachedAt: 0 };
  } catch {
    return null;
  }
}

async function setCached(key: string, html: string, ttl: number): Promise<void> {
  try {
    const entry: CacheEntry = { html, cachedAt: Date.now() };
    await getCacheClient().set(key, JSON.stringify(entry), "EX", ttl);
  } catch {
    // cache write failures are non-critical
  }
}

/** Inject a "cached since" badge into HTML before </body> */
function injectCacheBadge(html: string, cachedAt: number): string {
  if (!cachedAt) return html;
  const badge = `<div style="position:fixed;bottom:8px;right:8px;z-index:50;opacity:0.6;pointer-events:none" class="text-xs text-base-content/50"><span data-cached-at="${cachedAt}"></span></div>
<script>(function(){var el=document.querySelector('[data-cached-at]');if(el){var t=parseInt(el.dataset.cachedAt);if(t){var d=new Date(t);el.textContent='Cached since '+d.toLocaleTimeString();}}})()</script>`;
  return html.replace("</body>", badge + "\n</body>");
}

// ─── HTML helpers ────────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Convert markdown text to safe HTML, rendering pipe tables as <table> elements */
function markdownToHtml(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect markdown table: a row of |...|, followed by a separator |---|...|
    if (
      i + 1 < lines.length &&
      lines[i].trim().startsWith("|") &&
      lines[i].trim().endsWith("|") &&
      /^\|[\s:-]+(\|[\s:-]+)+\|$/.test(lines[i + 1].trim())
    ) {
      // Parse header
      const headerCells = lines[i].trim().slice(1, -1).split("|").map(c => c.trim());
      i += 2; // skip header + separator

      // Parse body rows
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        bodyRows.push(lines[i].trim().slice(1, -1).split("|").map(c => c.trim()));
        i++;
      }

      let table = `<table class="table table-zebra table-sm w-auto"><thead><tr>`;
      for (const cell of headerCells) {
        table += `<th>${escapeHtml(cell)}</th>`;
      }
      table += `</tr></thead><tbody>`;
      for (const row of bodyRows) {
        table += `<tr>`;
        for (const cell of row) {
          table += `<td>${escapeHtml(cell)}</td>`;
        }
        table += `</tr>`;
      }
      table += `</tbody></table>`;
      out.push(table);
    } else {
      out.push(escapeHtml(lines[i]));
      i++;
    }
  }

  return out.join("<br>");
}

function htmlShell(title: string, body: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.23/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>
(function(){var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})();
</script>
${extraHead}
<style>
  .question-card .answer-content { white-space: pre-wrap; }
  .search-sticky { position: sticky; top: 0; z-index: 10; }
</style>
</head>
<body class="bg-base-200 min-h-screen">
<div class="navbar bg-base-100 shadow-sm mb-4">
  <div class="container mx-auto max-w-3xl flex justify-between">
    <span class="text-sm font-semibold opacity-70">${escapeHtml(title)}</span>
    <label class="swap swap-rotate btn btn-ghost btn-circle btn-sm" id="theme-toggle" aria-label="Toggle dark mode">
      <input type="checkbox" id="theme-checkbox" />
      <svg class="swap-off h-5 w-5 fill-current" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13ZM14,20A8.11,8.11,0,0,1,6.87,6.27a10.09,10.09,0,0,0,11.86,11.86A8.08,8.08,0,0,1,14,20Z"/></svg>
      <svg class="swap-on h-5 w-5 fill-current" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5.64,17l-.71.71a1,1,0,0,0,0,1.41,1,1,0,0,0,1.41,0l.71-.71A1,1,0,0,0,5.64,17ZM5,12a1,1,0,0,0-1-1H3a1,1,0,0,0,0,2H4A1,1,0,0,0,5,12Zm7-7a1,1,0,0,0,1-1V3a1,1,0,0,0-2,0V4A1,1,0,0,0,12,5ZM5.64,7.05a1,1,0,0,0,.7.29,1,1,0,0,0,.71-.29,1,1,0,0,0,0-1.41l-.71-.71A1,1,0,0,0,4.93,6.34Zm12,.29a1,1,0,0,0,.7-.29l.71-.71a1,1,0,1,0-1.41-1.41L17,5.64a1,1,0,0,0,0,1.41A1,1,0,0,0,17.66,7.34ZM21,11H20a1,1,0,0,0,0,2h1a1,1,0,0,0,0-2Zm-9,8a1,1,0,0,0-1,1v1a1,1,0,0,0,2,0V20A1,1,0,0,0,12,19ZM18.36,17A1,1,0,0,0,17,18.36l.71.71a1,1,0,0,0,1.41,0,1,1,0,0,0,0-1.41ZM12,6.5A5.5,5.5,0,1,0,17.5,12,5.51,5.51,0,0,0,12,6.5Zm0,9A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z"/></svg>
    </label>
  </div>
</div>
${body}
<script>
(function(){
  var cb=document.getElementById('theme-checkbox');
  var current=document.documentElement.getAttribute('data-theme');
  cb.checked=current==='dark';
  cb.addEventListener('change',function(){
    var theme=cb.checked?'dark':'light';
    document.documentElement.setAttribute('data-theme',theme);
    localStorage.setItem('theme',theme);
  });
})();
</script>
</body>
</html>`;
}

// ─── Data helpers ────────────────────────────────────────────────

/** Find the latest completed pipeline run for a tenant */
async function getLatestCompletedRun(tenantId: string) {
  const db = getDb();
  return db.pipelineRun.findFirst({
    where: { tenantId, status: "COMPLETED", parentRunId: null },
    orderBy: { completedAt: "desc" },
    select: { id: true, tenantId: true },
  });
}

/** Read a split JSON file from disk */
async function readSplitFile(tenantId: string, runId: string, filename: string): Promise<SplitFile | null> {
  const config = getConfig();
  const filePath = join(config.OUTPUT_DIR, tenantId, runId, "split", filename);
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as SplitFile;
  } catch {
    return null;
  }
}


/** Pick the best representative question from a group */
function pickRepresentative(group: QuestionItem[]): QuestionItem {
  const sorted = [...group].sort((a, b) => {
    const aLen = a.data?.question_text?.length ?? 0;
    const bLen = b.data?.question_text?.length ?? 0;
    if (bLen !== aLen) return bLen - aLen;
    const aAns = a.data?.correct_answer?.length ?? 0;
    const bAns = b.data?.correct_answer?.length ?? 0;
    return bAns - aAns;
  });
  // Prefer one with a non-empty answer
  return sorted.find((q) => q.data?.correct_answer?.trim()) || sorted[0];
}

// ─── Render functions ────────────────────────────────────────────

function renderTenantIndex(tenant: { name: string; slug: string }, categories: CategoryGroup[]): string {
  const breadcrumb = `<div class="text-sm breadcrumbs mb-4"><ul><li>${escapeHtml(tenant.name)}</li></ul></div>`;

  let cards = "";
  for (const cat of categories) {
    const catUrl = `/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(cat.key)}`;
    cards += `<div class="card bg-base-100 shadow-sm mb-3">
      <div class="card-body p-4">
        <a href="${catUrl}" class="text-lg font-semibold link link-hover">${escapeHtml(cat.name)}</a>`;

    if (cat.subcategories.length > 0) {
      cards += `<div class="flex flex-wrap gap-2 mt-2">`;
      for (const sub of cat.subcategories) {
        const subUrl = `/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(cat.key)}/${encodeURIComponent(sub.key)}`;
        cards += `<a href="${subUrl}" class="badge badge-outline badge-lg hover:badge-primary cursor-pointer">${escapeHtml(sub.name)}</a>`;
      }
      cards += `</div>`;
    }
    cards += `</div></div>`;
  }

  if (!cards) {
    cards = `<div class="alert alert-info">No categories available yet.</div>`;
  }

  const body = `<div class="container mx-auto p-4 max-w-3xl">
    ${breadcrumb}
    <h1 class="text-2xl font-bold mb-6">${escapeHtml(tenant.name)}</h1>
    ${cards}
  </div>`;

  return htmlShell(tenant.name, body);
}

function renderCategoryPage(
  tenant: { name: string; slug: string },
  category: CategoryGroup,
): string {
  const tenantUrl = `/${encodeURIComponent(tenant.slug)}`;
  const breadcrumb = `<div class="text-sm breadcrumbs mb-4"><ul>
    <li><a href="${tenantUrl}">${escapeHtml(tenant.name)}</a></li>
    <li>${escapeHtml(category.name)}</li>
  </ul></div>`;

  let cards = "";
  if (category.subcategories.length === 0) {
    cards = `<div class="alert alert-info">No subcategories available.</div>`;
  } else {
    for (const sub of category.subcategories) {
      const subUrl = `/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(category.key)}/${encodeURIComponent(sub.key)}`;
      cards += `<a href="${subUrl}" class="card bg-base-100 shadow-sm mb-3 hover:shadow-md transition-shadow">
        <div class="card-body p-4">
          <span class="text-lg font-semibold">${escapeHtml(sub.name)}</span>
        </div>
      </a>`;
    }
  }

  const body = `<div class="container mx-auto p-4 max-w-3xl">
    ${breadcrumb}
    <h1 class="text-2xl font-bold mb-6">${escapeHtml(category.name)}</h1>
    ${cards}
  </div>`;

  return htmlShell(`${category.name} — ${tenant.name}`, body);
}

function renderSubcategoryPage(
  tenant: { name: string; slug: string },
  categoryName: string,
  categoryKey: string,
  subcategoryName: string,
  groups: QuestionItem[][],
  markedWrongFiles: Set<string> = new Set(),
): string {
  const tenantUrl = `/${encodeURIComponent(tenant.slug)}`;
  const catUrl = `/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(categoryKey)}`;
  const breadcrumb = `<div class="text-sm breadcrumbs mb-4"><ul>
    <li><a href="${tenantUrl}">${escapeHtml(tenant.name)}</a></li>
    <li><a href="${catUrl}">${escapeHtml(categoryName)}</a></li>
    <li>${escapeHtml(subcategoryName)}</li>
  </ul></div>`;

  // Sort groups by size desc (most duplicates first)
  const sortedGroups = [...groups].sort((a, b) => b.length - a.length);

  let questionCards = "";
  for (let i = 0; i < sortedGroups.length; i++) {
    const group = sortedGroups[i];
    const item = pickRepresentative(group);
    const count = group.length;
    const qType = item.data?.question_type || "open";
    const points = item.data?.points;
    const questionText = markdownToHtml(item.data?.question_text || "");
    const answerText = markdownToHtml(item.data?.correct_answer || "");

    // Badge colors by type
    const typeBadge =
      qType === "multiple_choice"
        ? `<span class="badge badge-info badge-sm">Multiple Choice</span>`
        : qType === "true_false"
          ? `<span class="badge badge-accent badge-sm">True/False</span>`
          : `<span class="badge badge-ghost badge-sm">Open</span>`;

    // Options for multiple choice
    let optionsHtml = "";
    if (item.data?.options && item.data.options.length > 0) {
      optionsHtml = `<ul class="list-disc list-inside space-y-1 mt-3 text-sm">`;
      for (const opt of item.data.options) {
        optionsHtml += `<li>${markdownToHtml(opt)}</li>`;
      }
      optionsHtml += `</ul>`;
    }

    const isMarkedWrong = markedWrongFiles.has(item.file);
    const wrongBadge = isMarkedWrong ? `<span class="badge badge-error badge-sm">Reported</span>` : "";
    const cardBorder = isMarkedWrong ? ` border border-error/30` : "";

    questionCards += `<div class="card bg-base-100 shadow-sm question-card${cardBorder}" data-file="${escapeHtml(item.file)}" data-search="${escapeHtml((item.data?.question_text || "").toLowerCase() + " " + (item.data?.correct_answer || "").toLowerCase())}">
      <div class="card-body p-4">
        <div class="flex items-center gap-2 mb-2">
          ${typeBadge}
          ${points ? `<span class="badge badge-secondary badge-sm">${points} pt</span>` : ""}
          ${count > 1 ? `<span class="badge badge-warning badge-sm">&times;${count}</span>` : ""}
          ${wrongBadge}
        </div>
        <div class="prose prose-sm max-w-none">${questionText}</div>
        ${optionsHtml}
        <div class="answer-container mt-3 hidden" id="answer-${i}">
          <div class="p-3 bg-success/10 rounded-lg">
            <h3 class="font-semibold text-success text-sm mb-1">Answer:</h3>
            <div class="prose prose-sm max-w-none answer-content">${answerText}</div>
          </div>
        </div>
        <div class="card-actions justify-center mt-3">
          <button class="btn btn-primary btn-sm answer-toggle" data-target="answer-${i}">Show Answer</button>
          <button class="btn btn-error btn-sm btn-outline mark-wrong-btn${isMarkedWrong ? " btn-disabled" : ""}" data-file="${escapeHtml(item.file)}">${isMarkedWrong ? "Reported" : "Report Wrong"}</button>
        </div>
      </div>
    </div>`;
  }

  if (!questionCards) {
    questionCards = `<div class="alert alert-info">No questions available.</div>`;
  }

  const totalQuestions = sortedGroups.length;

  const searchBar = `<div class="search-sticky bg-base-200 py-3">
    <div class="flex gap-2">
      <input type="text" id="search-input" placeholder="Search questions..." class="input input-bordered w-full" />
      <button id="search-clear" class="btn btn-ghost btn-square">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="text-sm text-base-content/60 mt-1"><span id="visible-count">${totalQuestions}</span> / ${totalQuestions} questions</div>
  </div>`;

  const script = `<script>
(function() {
  var slug = ${JSON.stringify(tenant.slug)};

  // Answer toggle
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.answer-toggle');
    if (!btn) return;
    var target = document.getElementById(btn.dataset.target);
    if (!target) return;
    var hidden = target.classList.contains('hidden');
    target.classList.toggle('hidden');
    btn.textContent = hidden ? 'Hide Answer' : 'Show Answer';
  });

  // Mark wrong
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.mark-wrong-btn');
    if (!btn || btn.classList.contains('btn-disabled')) return;
    var file = btn.dataset.file;
    if (!file) return;
    btn.classList.add('loading');
    fetch('/' + encodeURIComponent(slug) + '/mark-wrong', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: file })
    }).then(function(res) {
      btn.classList.remove('loading');
      if (res.ok) {
        btn.textContent = 'Reported';
        btn.classList.add('btn-disabled');
        btn.classList.remove('btn-outline');
        var card = btn.closest('.question-card');
        if (card) card.classList.add('border', 'border-error/30');
        var badges = card.querySelector('.flex.items-center.gap-2');
        if (badges) {
          var badge = document.createElement('span');
          badge.className = 'badge badge-error badge-sm';
          badge.textContent = 'Reported';
          badges.appendChild(badge);
        }
      } else {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Report Wrong'; }, 2000);
      }
    }).catch(function() {
      btn.classList.remove('loading');
      btn.textContent = 'Error';
      setTimeout(function() { btn.textContent = 'Report Wrong'; }, 2000);
    });
  });

  // Search with debounce
  var searchInput = document.getElementById('search-input');
  var clearBtn = document.getElementById('search-clear');
  var visibleCount = document.getElementById('visible-count');
  var cards = document.querySelectorAll('.question-card');
  var debounceTimer;

  function filterCards() {
    var query = searchInput.value.toLowerCase().trim();
    var count = 0;
    cards.forEach(function(card) {
      var text = card.dataset.search || '';
      var show = !query || text.indexOf(query) !== -1;
      card.style.display = show ? '' : 'none';
      if (show) count++;
    });
    visibleCount.textContent = count;
  }

  searchInput.addEventListener('input', function() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(filterCards, 300);
  });

  clearBtn.addEventListener('click', function() {
    searchInput.value = '';
    filterCards();
    searchInput.focus();
  });
})();
</script>`;

  const body = `<div class="container mx-auto p-4 max-w-3xl">
    ${breadcrumb}
    <h1 class="text-2xl font-bold mb-2">${escapeHtml(subcategoryName)}</h1>
    <p class="text-sm text-base-content/60 mb-4">${escapeHtml(categoryName)}</p>
    ${searchBar}
    <div class="space-y-3 mt-3" id="questions-container">
      ${questionCards}
    </div>
  </div>
  ${script}`;

  return htmlShell(`${subcategoryName} — ${categoryName} — ${tenant.name}`, body);
}

// ─── Filename sanitization (mirrors category-split worker logic) ──
const HU_TO_EN: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ö: "o", ő: "o",
  ú: "u", ü: "u", ű: "u",
  Á: "A", É: "E", Í: "I", Ó: "O", Ö: "O", Ő: "O",
  Ú: "U", Ü: "U", Ű: "U",
};

function transliterate(text: string): string {
  let result = text;
  for (const [hu, en] of Object.entries(HU_TO_EN)) {
    result = result.replaceAll(hu, en);
  }
  return result;
}

function sanitizeFilename(name: string): string {
  let safe = transliterate(name);
  safe = safe.replace(/[^a-zA-Z0-9\s-]/g, "");
  safe = safe.replace(/\s+/g, "_");
  return safe.toLowerCase();
}

// ─── Category grouping types ─────────────────────────────────────
interface SubcategoryInfo {
  key: string;
  name: string;
  file: string;
}

interface CategoryGroup {
  key: string;
  name: string;
  sortOrder: number;
  subcategories: SubcategoryInfo[];
}

/** Build category groups from TenantCategory rows */
function buildCategoryGroups(
  categories: { key: string; name: string; subcategory: string | null; file: string; sortOrder: number }[],
): CategoryGroup[] {
  const map = new Map<string, CategoryGroup>();

  for (const cat of categories) {
    // The "base" category key is derived from the key field
    // Keys follow format: "category_key" or "category_key:subcategory"
    const baseKey = cat.key.includes(":") ? cat.key.split(":")[0] : cat.key;

    if (!map.has(baseKey)) {
      map.set(baseKey, {
        key: baseKey,
        name: cat.name,
        sortOrder: cat.sortOrder,
        subcategories: [],
      });
    }

    const group = map.get(baseKey)!;
    // Update sortOrder to minimum
    if (cat.sortOrder < group.sortOrder) {
      group.sortOrder = cat.sortOrder;
    }

    if (cat.subcategory) {
      // Use sanitized subcategory name as key — matches split filenames on disk
      const subKey = sanitizeFilename(cat.subcategory);
      group.subcategories.push({
        key: subKey,
        name: cat.subcategory,
        file: `${subKey}.json`,
      });
    }
  }

  // Sort subcategories alphabetically
  for (const group of map.values()) {
    group.subcategories.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Sort groups by sortOrder
  return [...map.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

// ─── Route registration ──────────────────────────────────────────
export async function publicRoutes(app: FastifyInstance) {
  const config = getConfig();
  const cacheTtl = config.CACHE_TTL_SECONDS;

  // GET /:slug — tenant index: list categories and subcategories
  app.get<{ Params: { slug: string } }>("/:slug", {
    handler: async (request, reply) => {
      const { slug } = request.params;

      // Avoid matching API and health routes
      if (slug === "api" || slug === "health" || slug === "ready" || slug === "assets") {
        return reply.code(404).send({ error: "Not found" });
      }

      const cacheKey = `public:tenant:${slug}`;
      const cached = await getCached(cacheKey);
      if (cached) {
        reply.type("text/html; charset=utf-8");
        return reply.send(injectCacheBadge(cached.html, cached.cachedAt));
      }

      const db = getDb();
      const tenant = await db.tenant.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true, isActive: true },
      });

      if (!tenant || !tenant.isActive) {
        return reply.code(404).type("text/html; charset=utf-8").send(
          htmlShell("Not Found", `<div class="container mx-auto p-4"><div class="alert alert-error">Tenant not found.</div></div>`),
        );
      }

      const categories = await db.tenantCategory.findMany({
        where: { tenantId: tenant.id },
        orderBy: { sortOrder: "asc" },
        select: { key: true, name: true, subcategory: true, file: true, sortOrder: true },
      });

      const groups = buildCategoryGroups(categories);
      const html = renderTenantIndex({ name: tenant.name, slug: tenant.slug }, groups);

      await setCached(cacheKey, html, cacheTtl);
      reply.type("text/html; charset=utf-8");
      return reply.send(html);
    },
  });

  // GET /:slug/:categoryKey — category page: list subcategories
  app.get<{ Params: { slug: string; categoryKey: string } }>("/:slug/:categoryKey", {
    handler: async (request, reply) => {
      const { slug, categoryKey } = request.params;

      // Avoid matching API routes
      if (slug === "api" || slug === "health" || slug === "ready" || slug === "assets") {
        return reply.code(404).send({ error: "Not found" });
      }

      const cacheKey = `public:category:${slug}:${categoryKey}`;
      const cached = await getCached(cacheKey);
      if (cached) {
        reply.type("text/html; charset=utf-8");
        return reply.send(injectCacheBadge(cached.html, cached.cachedAt));
      }

      const db = getDb();
      const tenant = await db.tenant.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true, isActive: true },
      });

      if (!tenant || !tenant.isActive) {
        return reply.code(404).type("text/html; charset=utf-8").send(
          htmlShell("Not Found", `<div class="container mx-auto p-4"><div class="alert alert-error">Tenant not found.</div></div>`),
        );
      }

      const categories = await db.tenantCategory.findMany({
        where: { tenantId: tenant.id },
        orderBy: { sortOrder: "asc" },
        select: { key: true, name: true, subcategory: true, file: true, sortOrder: true },
      });

      const groups = buildCategoryGroups(categories);
      const category = groups.find((g) => g.key === categoryKey);

      if (!category) {
        return reply.code(404).type("text/html; charset=utf-8").send(
          htmlShell("Not Found", `<div class="container mx-auto p-4"><div class="alert alert-error">Category not found.</div></div>`),
        );
      }

      const html = renderCategoryPage({ name: tenant.name, slug: tenant.slug }, category);
      await setCached(cacheKey, html, cacheTtl);
      reply.type("text/html; charset=utf-8");
      return reply.send(html);
    },
  });

  // GET /:slug/:categoryKey/:subcategoryKey — subcategory questions page
  app.get<{ Params: { slug: string; categoryKey: string; subcategoryKey: string } }>(
    "/:slug/:categoryKey/:subcategoryKey",
    {
      handler: async (request, reply) => {
        const { slug, categoryKey, subcategoryKey } = request.params;

        // Avoid matching API routes
        if (slug === "api" || slug === "health" || slug === "ready" || slug === "assets") {
          return reply.code(404).send({ error: "Not found" });
        }

        const cacheKey = `public:questions:${slug}:${categoryKey}:${subcategoryKey}`;
        const cached = await getCached(cacheKey);
        if (cached) {
          reply.type("text/html; charset=utf-8");
          return reply.send(injectCacheBadge(cached.html, cached.cachedAt));
        }

        const db = getDb();
        const tenant = await db.tenant.findUnique({
          where: { slug },
          select: { id: true, name: true, slug: true, isActive: true },
        });

        if (!tenant || !tenant.isActive) {
          return reply.code(404).type("text/html; charset=utf-8").send(
            htmlShell("Not Found", `<div class="container mx-auto p-4"><div class="alert alert-error">Tenant not found.</div></div>`),
          );
        }

        // Find the TenantCategory matching this subcategory key
        // subcategoryKey is the filename without .json
        const filename = `${subcategoryKey}.json`;

        // Get latest completed run
        const latestRun = await getLatestCompletedRun(tenant.id);
        if (!latestRun) {
          return reply.code(404).type("text/html; charset=utf-8").send(
            htmlShell("No Data", `<div class="container mx-auto p-4"><div class="alert alert-warning">No completed pipeline runs available.</div></div>`),
          );
        }

        // Read the split file
        const splitData = await readSplitFile(tenant.id, latestRun.id, filename);
        if (!splitData) {
          // Try to find by listing files (fallback)
          return reply.code(404).type("text/html; charset=utf-8").send(
            htmlShell("Not Found", `<div class="container mx-auto p-4"><div class="alert alert-error">Subcategory data not found.</div></div>`),
          );
        }

        // Get category info for breadcrumbs
        const categories = await db.tenantCategory.findMany({
          where: { tenantId: tenant.id },
          orderBy: { sortOrder: "asc" },
          select: { key: true, name: true, subcategory: true, file: true, sortOrder: true },
        });
        const groups = buildCategoryGroups(categories);
        const category = groups.find((g) => g.key === categoryKey);
        const categoryName = category?.name || splitData.category_name || categoryKey;
        const subcategoryName = splitData.subcategory_name || subcategoryKey;

        // Fetch which question files in this tenant are already marked wrong
        const allFiles: string[] = (splitData.groups || []).flat().map((q) => q.file);
        const markedWrongQuestions = allFiles.length > 0
          ? await db.question.findMany({
              where: { tenantId: tenant.id, file: { in: allFiles }, markedWrong: true },
              select: { file: true },
            })
          : [];
        const markedWrongFiles = new Set<string>(markedWrongQuestions.map((q) => q.file));

        const html = renderSubcategoryPage(
          { name: tenant.name, slug: tenant.slug },
          categoryName,
          categoryKey,
          subcategoryName,
          splitData.groups || [],
          markedWrongFiles,
        );

        await setCached(cacheKey, html, cacheTtl);
        reply.type("text/html; charset=utf-8");
        return reply.send(html);
      },
    },
  );

  // POST /:slug/mark-wrong — guest marks a question as wrong (no auth)
  app.post<{ Params: { slug: string }; Body: { file: string } }>("/:slug/mark-wrong", {
    handler: async (request, reply) => {
      const { slug } = request.params;
      const { file } = request.body ?? {};

      if (!file || typeof file !== "string") {
        return reply.code(400).send({ error: "file is required" });
      }

      const db = getDb();
      const tenant = await db.tenant.findUnique({
        where: { slug },
        select: { id: true, isActive: true },
      });

      if (!tenant || !tenant.isActive) {
        return reply.code(404).send({ error: "Not found" });
      }

      const question = await db.question.findUnique({
        where: { tenantId_file: { tenantId: tenant.id, file } },
      });

      if (!question) {
        return reply.code(404).send({ error: "Question not found" });
      }

      if (!question.markedWrong) {
        await db.question.update({
          where: { id: question.id },
          data: { markedWrong: true, markedWrongAt: new Date() },
        });

        // Invalidate cached pages for this tenant so the badge shows up
        try {
          const cache = getCacheClient();
          const keys = await cache.keys(`public:questions:${slug}:*`);
          if (keys.length > 0) await cache.del(...keys);
        } catch {
          // cache invalidation failure is non-critical
        }
      }

      return reply.code(200).send({ ok: true });
    },
  });
}
