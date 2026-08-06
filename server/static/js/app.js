'use strict';

// ── Security: Freeze Object.prototype to prevent prototype pollution
// (code-security/rules/prototype-pollution.md — CWE-915)
Object.freeze(Object.prototype);

// ── DANGEROUS_KEYS denylist for any dynamic property access from user data
const DANGEROUS_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

// ── CSRF token injected by Jinja2 server-side (not from user input)
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]').content;

// ── Server-provided vault path (read-only context, not user-modifiable)
const VAULT_PATH = document.querySelector('meta[name="vault-path"]').content;

// ── Active API token — fetched from server, never from URL params
let activeToken = null;

// ── Application state (null-prototype to avoid prototype pollution)
const state = Object.create(null);
state.currentFile   = null;   // currently open file path
state.currentContent = '';    // raw markdown content
state.mode           = 'reading'; // 'reading' | 'editing'
state.unsaved        = false;
state.treeData       = [];    // flat file list
state.searchFilter   = '';
state.sidebarOpen    = true;

// ── Auto-save debounce timer
let autoSaveTimer = null;


/* ════════════════════════════════════════════════════════════════
   SECURITY UTILITIES
   • XSS: All user-facing strings escape via textContent or DOMPurify
   • Path traversal: sanitizeFilePath validates all file paths
   ════════════════════════════════════════════════════════════════ */

/**
 * XSS-safe HTML escape for any user content injected as text.
 * (code-security/rules/xss.md — CWE-79)
 */
function escapeHtml(str) {
  if (str == null) return '';
  const el = document.createElement('div');
  el.textContent = String(str);
  return el.innerHTML;
}

/**
 * Sanitize a vault-relative file path.
 * Blocks path traversal sequences (../ or ..\) and null bytes.
 * (code-security/rules/path-traversal.md — CWE-22)
 */
function sanitizeFilePath(raw) {
  if (typeof raw !== 'string') return null;
  // Reject null bytes, backslash sequences, and directory traversal
  if (raw.includes('\0')) return null;
  if (/\.\.[\\/]/.test(raw)) return null;
  if (/^\.\./.test(raw)) return null;
  // Reject absolute paths
  if (/^[\\/]/.test(raw)) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;
  return raw.trim();
}

/**
 * DOMPurify configuration for rendered Markdown HTML.
 * Allows KaTeX math output (SVG, MathML) and callout classes.
 * Explicitly blocks javascript: URIs, event handlers, and object/embed.
 * (code-security/rules/xss.md — Use sanitization libraries)
 */
const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: [
    // Headings, block
    'h1','h2','h3','h4','h5','h6','p','br','hr','blockquote','pre','code',
    // Lists
    'ul','ol','li',
    // Inline
    'a','strong','em','del','ins','mark','sub','sup','span','kbd','abbr',
    // Table
    'table','thead','tbody','tfoot','tr','th','td','caption',
    // Media
    'img','figure','figcaption',
    // Form (checkboxes only)
    'input',
    // KaTeX / Math
    'math','mrow','mi','mo','mn','mfrac','msqrt','mroot','msup','msub',
    'msubsup','munder','mover','munderover','mtable','mtr','mtd','mtext',
    'annotation','semantics',
    // SVG (KaTeX)
    'svg','path','rect','circle','line','g','use','defs','symbol',
    'text','tspan','clippath','mask',
    // Callouts and structure
    'div','section','details','summary',
  ],
  ALLOWED_ATTR: [
    'href','src','alt','title','class','id','style','type','checked',
    'readonly','disabled','target','rel',
    // KaTeX
    'd','viewBox','xmlns','fill','stroke','stroke-width','x','y',
    'width','height','transform','cx','cy','r','rx','ry','x1','y1','x2','y2',
    'font-size','text-anchor','dominant-baseline','data-type',
    'aria-label','aria-hidden','role',
    // Math
    'display','mathvariant','scriptlevel',
  ],
  FORBID_TAGS: ['script','iframe','object','embed','form','base','link','meta','style'],
  FORBID_ATTR: ['onerror','onload','onclick','onmouseover','onfocus','onblur',
                'onchange','onsubmit','onkeydown','onkeyup','onkeypress'],
  // Allow SVG + MathML for KaTeX
  ADD_TAGS: ['math', 'svg'],
  FORCE_BODY: true,
  ALLOW_DATA_ATTR: false,
  // Strip javascript: and data: URIs from href/src
  ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|mailto|obsidian):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

// Enforce external links have safe rel attributes (XSS: open redirect defense)
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^https?:/.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});


/* ════════════════════════════════════════════════════════════════
   MARKDOWN RENDERING ENGINE
   Obsidian Flavored Markdown:
   - Wikilinks [[Note]] and [[Note|Alias]]
   - Callouts > [!TYPE]
   - Task checkboxes - [ ] and - [x]
   - LaTeX math via KaTeX
   - Code syntax highlighting via highlight.js
   ════════════════════════════════════════════════════════════════ */

// Configure Marked.js
const markedRenderer = new marked.Renderer();

// Obsidian Comments: %% comment %%
function preprocessObsidianComments(text) {
  return text.replace(/%%[\s\S]*?%%/g, '');
}

// Obsidian Highlights: ==highlight==
function preprocessObsidianHighlights(text) {
  return text.replace(/==([^=\n]+?)==/g, '<mark>$1</mark>');
}

// Wikilink handler: [[Note]] or [[Note|Alias]]
function parseWikilinks(html) {
  return html.replace(/\[\[([^\]]+)\]\]/g, (match, inner) => {
    const pipeIdx = inner.indexOf('|');
    let target, label;
    if (pipeIdx > -1) {
      target = inner.slice(0, pipeIdx).trim();
      label  = inner.slice(pipeIdx + 1).trim();
    } else {
      target = inner.trim();
      label  = target;
    }
    const safeTarget = escapeHtml(target);
    const safeLabel  = escapeHtml(label);
    return `<a class="wikilink" data-target="${safeTarget}">${safeLabel}</a>`;
  });
}

// Obsidian Embeds: ![[file.png]] or ![[file.png|200]] or ![[file.png|200x150]]
function parseObsidianEmbeds(html) {
  return html.replace(/!\[\[([^\]]+)\]\]/g, (match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const sizeStr = parts[1] ? parts[1].trim() : '';
    let widthAttr = '', heightAttr = '';
    if (sizeStr) {
      if (sizeStr.includes('x')) {
        const [w, h] = sizeStr.split('x');
        if (w && !isNaN(w)) widthAttr = ` width="${parseInt(w, 10)}"`;
        if (h && !isNaN(h)) heightAttr = ` height="${parseInt(h, 10)}"`;
      } else if (!isNaN(sizeStr)) {
        widthAttr = ` width="${parseInt(sizeStr, 10)}"`;
      }
    }
    const safeTarget = escapeHtml(sanitizeFilePath(target) || target);
    return `<img src="/api/files/${encodeURIComponent(safeTarget)}" alt="${safeTarget}"${widthAttr}${heightAttr} class="obsidian-embed-img" />`;
  });
}

// Obsidian Callout parser: > [!TYPE] Title or > [!TYPE]- Collapsed Title
function parseCallouts(html) {
  return html.replace(
    /<blockquote>\s*<p>\[!([A-Z0-9_-]+)\]([+-]?)([^\n]*?)([\s\S]*?)<\/p>\s*<\/blockquote>/gi,
    (match, type, fold, titleRest, body) => {
      const t = type.toLowerCase();
      const icons = {
        note:'ℹ️', tip:'💡', hint:'💡', important:'⚡', todo:'📋', warning:'⚠️',
        attention:'⚠️', caution:'🔴', danger:'🚨', bug:'🐛', success:'✅', done:'✅',
        info:'ℹ️', question:'❓', help:'❓', faq:'❓', example:'📋', quote:'💬',
      };
      const icon = icons[t] || 'ℹ️';
      const titleText = titleRest.trim() || type.toUpperCase();
      const bodyContent = body.trim() ? `<div class="callout-body">${body.trim()}</div>` : '';
      
      const isFoldable = fold === '-' || fold === '+';
      const isCollapsed = fold === '-';
      
      if (isFoldable) {
        return `<details class="callout" data-type="${escapeHtml(t)}"${isCollapsed ? '' : ' open'}>
          <summary class="callout-title"><span class="callout-icon">${icon}</span>${escapeHtml(titleText)}</summary>
          ${bodyContent}
        </details>`;
      }
      return `<div class="callout" data-type="${escapeHtml(t)}">
        <div class="callout-title"><span class="callout-icon">${icon}</span>${escapeHtml(titleText)}</div>
        ${bodyContent}
      </div>`;
    }
  );
}

// Extended Task checkbox: - [ ], - [x], - [-], - [/], - [?], - [!]
function parseTaskCheckboxes(html) {
  return html
    .replace(/<li>\s*\[ \]/g, '<li><input type="checkbox" disabled> ')
    .replace(/<li>\s*\[[xX]\]/g, '<li><input type="checkbox" checked disabled> ')
    .replace(/<li>\s*\[-\]/g, '<li><input type="checkbox" disabled class="task-cancelled"> ')
    .replace(/<li>\s*\[\/\]/g, '<li><input type="checkbox" disabled class="task-in-progress"> ')
    .replace(/<li>\s*\[\?\]/g, '<li><input type="checkbox" disabled class="task-question"> ')
    .replace(/<li>\s*\[!\]/g, '<li><input type="checkbox" disabled class="task-important"> ');
}

// Protect math blocks before Marked processes them, then restore
function preprocessMath(text) {
  const blocks = [];
  // Block math $$...$$ (must come first)
  text = text.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
    blocks.push({ type: 'block', src: m.slice(2, -2) });
    return `%%MATH_BLOCK_${blocks.length - 1}%%`;
  });
  // Inline math $...$
  text = text.replace(/\$([^$\n]+?)\$/g, (m, inner) => {
    blocks.push({ type: 'inline', src: inner });
    return `%%MATH_INLINE_${blocks.length - 1}%%`;
  });
  return { text, blocks };
}

function restoreMath(html, blocks) {
  html = html.replace(/%%MATH_BLOCK_(\d+)%%/g, (m, i) => {
    try {
      return '<div class="katex-block">' + katex.renderToString(blocks[+i].src, { displayMode:true, throwOnError:false }) + '</div>';
    } catch { return escapeHtml(blocks[+i].src); }
  });
  html = html.replace(/%%MATH_INLINE_(\d+)%%/g, (m, i) => {
    try {
      return katex.renderToString(blocks[+i].src, { displayMode:false, throwOnError:false });
    } catch { return escapeHtml(blocks[+i].src); }
  });
  return html;
}

marked.setOptions({
  gfm: true,
  breaks: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang }).value; } catch {}
    }
    return hljs.highlightAuto(code).value;
  },
});

// Automatic YAML & Frontmatter Preprocessor
function preprocessYAML(text) {
  if (!text) return '';

  // 1. Process Frontmatter at top of document (--- ... ---)
  text = text.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, (match, yamlContent) => {
    return `\`\`\`yaml\n${yamlContent.trim()}\n\`\`\`\n\n`;
  });

  // 2. Process unfenced YAML / indented key-value blocks
  const lines = text.split('\n');
  const result = [];
  let inCodeFence = false;
  let yamlBlock = [];

  const isYamlLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return yamlBlock.length > 0;
    if (trimmed.startsWith('#')) return true;
    if (trimmed.startsWith('- ')) return true;
    return /^\s*([a-zA-Z0-9_\-\.\s"']+)\s*:\s*(.*)$/.test(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (yamlBlock.length > 0) {
        result.push('```yaml\n' + yamlBlock.join('\n') + '\n```');
        yamlBlock = [];
      }
      inCodeFence = !inCodeFence;
      result.push(line);
      continue;
    }

    if (inCodeFence) {
      result.push(line);
      continue;
    }

    if (isYamlLine(line)) {
      yamlBlock.push(line);
    } else {
      if (yamlBlock.length > 0) {
        const hasKeyValues = yamlBlock.filter(l => l.includes(':')).length;
        if (hasKeyValues >= 2) {
          result.push('```yaml\n' + yamlBlock.join('\n') + '\n```');
        } else {
          result.push(...yamlBlock);
        }
        yamlBlock = [];
      }
      result.push(line);
    }
  }

  if (yamlBlock.length > 0) {
    const hasKeyValues = yamlBlock.filter(l => l.includes(':')).length;
    if (hasKeyValues >= 2) {
      result.push('```yaml\n' + yamlBlock.join('\n') + '\n```');
    } else {
      result.push(...yamlBlock);
    }
  }

  return result.join('\n');
}

/**
 * Render Obsidian Flavored Markdown to safe HTML.
 * Pipeline: preprocess YAML & comments & highlights & math → Marked GFM →
 *           Obsidian Embeds → Wikilinks → Callouts → Checkboxes →
 *           restore math → DOMPurify sanitize
 */
function renderMarkdown(rawMd) {
  // 1. Preprocess YAML frontmatter & unfenced YAML blocks
  let mdPrepped = preprocessYAML(rawMd);

  // 2. Preprocess comments and highlights
  mdPrepped = preprocessObsidianComments(mdPrepped);
  mdPrepped = preprocessObsidianHighlights(mdPrepped);

  // 3. Protect math blocks from Marked's parser
  const { text: mdMathPrepped, blocks } = preprocessMath(mdPrepped);

  // 4. Render GFM markdown
  let html = marked.parse(mdMathPrepped);

  // 5. Obsidian syntax extensions
  html = parseObsidianEmbeds(html);
  html = parseWikilinks(html);
  html = parseCallouts(html);
  html = parseTaskCheckboxes(html);

  // 6. Restore math
  html = restoreMath(html, blocks);

  // 7. DOMPurify sanitize — MUST be last step before DOM injection (CWE-79)
  return DOMPurify.sanitize(html, DOMPURIFY_CONFIG);
}


/* ════════════════════════════════════════════════════════════════
   API CLIENT
   All requests include CSRF token and Bearer auth.
   Paths are sanitized before submission.
   ════════════════════════════════════════════════════════════════ */

async function apiRequest(method, path, body, extraHeaders = {}) {
  const headers = {
    'X-CSRF-Token': CSRF_TOKEN,
    ...extraHeaders,
  };
  if (activeToken) headers['Authorization'] = `Bearer ${activeToken}`;

  const opts = { method, headers };
  if (body !== undefined) {
    if (typeof body === 'string') {
      headers['Content-Type'] = 'text/plain';
      opts.body = body;
    } else {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }

  const res = await fetch(path, opts);
  return res;
}

async function fetchActiveToken() {
  try {
    const res = await fetch('/dashboard/tokens', { headers: { 'X-CSRF-Token': CSRF_TOKEN } });
    if (!res.ok) return null;
    const data = await res.json();
    // Use the first token — stored token_prefix only, full token never returned after creation
    if (data.tokens && data.tokens.length > 0) {
      // We can't get the raw token back, so we use session auth for /app API calls
      return null;
    }
  } catch {}
  return null;
}


/* ════════════════════════════════════════════════════════════════
   FILE TREE
   ════════════════════════════════════════════════════════════════ */

/**
 * Build a nested tree structure from a flat list of file paths.
 * Uses null-prototype objects to prevent prototype pollution (CWE-915).
 */
function buildTree(paths) {
  const root = Object.create(null);
  for (const filePath of paths) {
    // Sanitize each path entry from the server
    const safe = sanitizeFilePath(filePath);
    if (!safe) continue;
    const parts = safe.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Prototype pollution defense (code-security/rules/prototype-pollution.md)
      if (DANGEROUS_KEYS.has(part)) continue;
      if (i === parts.length - 1) {
        // Leaf: file
        if (!Object.prototype.hasOwnProperty.call(node, '__files__')) {
          node['__files__'] = [];
        }
        node['__files__'].push({ name: part, path: safe });
      } else {
        // Branch: folder
        if (!Object.prototype.hasOwnProperty.call(node, part)) {
          node[part] = Object.create(null);
        }
        node = node[part];
      }
    }
  }
  return root;
}

function renderTreeNode(node, prefix = '') {
  const frag = document.createDocumentFragment();

  // Files in this folder
  const files = node['__files__'] || [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.searchFilter && !file.path.toLowerCase().includes(state.searchFilter)) continue;
    const el = document.createElement('div');
    el.className = 'tree-item' + (state.currentFile === file.path ? ' active' : '');
    el.setAttribute('data-path', file.path);
    el.title = file.path;

    const icon = document.createElement('span');
    icon.style.cssText = 'flex-shrink:0;font-size:12px;opacity:0.5';
    icon.textContent = '📄';

    const label = document.createElement('span');
    label.className = 'item-label';
    // XSS safe: textContent only (CWE-79)
    label.textContent = file.name.replace(/\.md$/, '');

    const actions = document.createElement('span');
    actions.className = 'item-actions';

    // Rename button
    const renBtn = document.createElement('button');
    renBtn.className = 'action-btn';
    renBtn.title = 'Rename';
    renBtn.innerHTML = '✏️';
    renBtn.addEventListener('click', (e) => { e.stopPropagation(); promptRenameFile(file.path); });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.title = 'Delete';
    delBtn.innerHTML = '🗑️';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(file.path); });

    actions.appendChild(renBtn);
    actions.appendChild(delBtn);

    el.appendChild(icon);
    el.appendChild(label);
    el.appendChild(actions);
    el.addEventListener('click', () => openFile(file.path));
    frag.appendChild(el);
  }

  // Subfolders (sorted, filtered)
  const folders = Object.keys(node)
    .filter(k => k !== '__files__' && !DANGEROUS_KEYS.has(k))
    .sort((a, b) => a.localeCompare(b));

  for (const folder of folders) {
    if (state.searchFilter) {
      // When searching, only show folders that contain matching files
      const hasMatch = hasMatchingDescendant(node[folder]);
      if (!hasMatch) continue;
    }

    const wrap = document.createElement('div');
    wrap.className = 'tree-folder';

    const header = document.createElement('div');
    header.className = 'tree-item';
    header.style.fontWeight = '500';
    header.style.color = '#c0c0c0';

    const icon = document.createElement('span');
    icon.style.cssText = 'flex-shrink:0;font-size:12px;transition:transform .15s;';
    icon.textContent = '▾';

    const label = document.createElement('span');
    label.className = 'item-label';
    label.textContent = folder; // safe: textContent

    header.appendChild(icon);
    header.appendChild(label);
    header.addEventListener('click', () => {
      wrap.classList.toggle('collapsed');
      icon.style.transform = wrap.classList.contains('collapsed') ? 'rotate(-90deg)' : '';
    });

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.appendChild(renderTreeNode(node[folder], prefix + folder + '/'));

    wrap.appendChild(header);
    wrap.appendChild(children);
    frag.appendChild(wrap);
  }

  return frag;
}

function hasMatchingDescendant(node) {
  const files = node['__files__'] || [];
  if (files.some(f => f.path.toLowerCase().includes(state.searchFilter))) return true;
  return Object.keys(node)
    .filter(k => k !== '__files__' && !DANGEROUS_KEYS.has(k))
    .some(k => hasMatchingDescendant(node[k]));
}

async function loadFileTree() {
  const treeEl = document.getElementById('file-tree');
  treeEl.innerHTML = `<div class="empty-state !py-6"><span class="text-xs animate-spin inline-block">↻</span> <span class="text-xs ml-2">Loading…</span></div>`;
  try {
    const res = await fetch('/api/files', {
      headers: activeToken ? { 'Authorization': `Bearer ${activeToken}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.treeData = data.files || [];

    // Update vault label
    const vaultLabel = document.getElementById('vault-label');
    if (vaultLabel) vaultLabel.textContent = (data.vault_path || '').split('/').pop();

    renderFileTree();
  } catch (err) {
    treeEl.innerHTML = `<div class="empty-state !py-6"><p class="text-xs text-error">Failed to load vault: ${escapeHtml(err.message)}</p><p class="text-xs mt-2">Make sure you have an active API token configured.</p></div>`;
  }
}

function renderFileTree() {
  const treeEl = document.getElementById('file-tree');
  treeEl.innerHTML = '';

  const paths = state.treeData.map(f => typeof f === 'string' ? f : f.path);
  if (!paths.length) {
    treeEl.innerHTML = `<div class="empty-state !py-6"><p class="text-xs">Vault is empty.</p><p class="text-xs mt-1 text-muted">Create a new note to get started.</p></div>`;
    return;
  }

  const tree = buildTree(paths);
  treeEl.appendChild(renderTreeNode(tree));
}

function filterTree(query) {
  state.searchFilter = query.toLowerCase().trim();
  renderFileTree();
  if (state.searchFilter) {
    // Auto-expand all folders when filtering
    document.querySelectorAll('.tree-folder.collapsed').forEach(el => el.classList.remove('collapsed'));
  }
}


/* ════════════════════════════════════════════════════════════════
   FILE OPERATIONS
   ════════════════════════════════════════════════════════════════ */

async function openFile(filePath) {
  const safe = sanitizeFilePath(filePath);
  if (!safe) { showToast('Invalid file path.', 'error'); return; }

  try {
    const isBinary = !/\.(md|txt|csv|json|yaml|yml|py|js|ts|css|html|sh|bat|xml|ini)$/i.test(safe);
    const res = await fetch(`/api/files/${encodeURIComponent(safe)}`, {
      headers: activeToken ? { 'Authorization': `Bearer ${activeToken}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json();
    let content = '';
    if (!isBinary) {
        content = data.content || '';
    }

    state.currentFile    = safe;
    state.currentContent = content;
    state.unsaved        = false;

    // Always open in Reading Mode (default per spec)
    setMode('reading');
    updateEditorContent();
    updateActiveTreeItem(safe);
    document.getElementById('header-file-title').textContent = safe.split('/').pop().replace(/\.md$/, '');
    document.getElementById('file-actions').classList.remove('hidden');
    document.getElementById('file-actions').classList.add('flex');

  } catch (err) {
    showToast(`Could not open file: ${err.message}`, 'error');
  }
}

async function saveCurrentFile() {
  if (!state.currentFile) return;
  const safe = sanitizeFilePath(state.currentFile);
  if (!safe) return;

  const content = state.cmView ? state.cmView.getValue() : document.getElementById('editor-textarea').value;
  // 10 MB guard — mirrors server MAX_FILE_SIZE_BYTES (DoS defense)
  if (new Blob([content]).size > 10 * 1024 * 1024) {
    showToast('File too large to save (max 10 MB).', 'error');
    return;
  }

  setSaveStatus('Saving…');
  try {
    const headers = { 'Content-Type': 'text/plain', 'X-CSRF-Token': CSRF_TOKEN };
    if (activeToken) headers['Authorization'] = `Bearer ${activeToken}`;
    const res = await fetch(`/api/files/${encodeURIComponent(safe)}`, {
      method: 'POST', headers, body: content,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.currentContent = content;
    state.unsaved = false;
    setSaveStatus('Saved ✓');
    setTimeout(() => setSaveStatus(''), 2000);
    showToast('File saved.', 'success');
    // Update reader pane HTML in background without leaving edit mode
    const readerPane = document.getElementById('reader-pane');
    if (readerPane) readerPane.innerHTML = renderMarkdown(content);
  } catch (err) {
    setSaveStatus('Save failed');
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

async function deleteFile(filePath) {
  const safe = sanitizeFilePath(filePath || state.currentFile);
  if (!safe) return;

  const confirmed = await showConfirmModal(
    'Delete Note',
    `Are you sure you want to permanently delete "${safe.split('/').pop()}"? This cannot be undone.`,
    'Delete', 'danger'
  );
  if (!confirmed) return;

  try {
    const headers = { 'X-CSRF-Token': CSRF_TOKEN };
    if (activeToken) headers['Authorization'] = `Bearer ${activeToken}`;
    const res = await fetch(`/api/files/${encodeURIComponent(safe)}`, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    showToast('Note deleted.', 'success');
    if (state.currentFile === safe) {
      state.currentFile = null;
      state.currentContent = '';
      showWelcomeState();
    }
    await loadFileTree();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

function deleteCurrentFile() {
  if (!state.currentFile) return;
  deleteFile(state.currentFile);
}

async function createFile(filePath, content = '') {
  const safe = sanitizeFilePath(filePath);
  if (!safe) { showToast('Invalid file path.', 'error'); return; }

  try {
    const headers = { 'Content-Type': 'text/plain', 'X-CSRF-Token': CSRF_TOKEN };
    if (activeToken) headers['Authorization'] = `Bearer ${activeToken}`;
    const res = await fetch(`/api/files/${encodeURIComponent(safe)}`, {
      method: 'POST', headers, body: content,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Note created.', 'success');
    await loadFileTree();
    await openFile(safe);
  } catch (err) {
    showToast(`Could not create note: ${err.message}`, 'error');
  }
}

async function renameFile(oldPath, newPath) {
  const safeOld = sanitizeFilePath(oldPath);
  const safeNew = sanitizeFilePath(newPath);
  if (!safeOld || !safeNew) { showToast('Invalid file path.', 'error'); return; }

  try {
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN };
    if (activeToken) headers['Authorization'] = `Bearer ${activeToken}`;
    const res = await fetch('/api/files/rename', {
      method: 'POST', headers, body: JSON.stringify({ old_path: safeOld, new_path: safeNew })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Note renamed.', 'success');
    if (state.currentFile === safeOld) state.currentFile = safeNew;
    await loadFileTree();
    if (state.currentFile === safeNew) {
      document.getElementById('header-file-title').textContent = safeNew.split('/').pop().replace(/\.md$/, '');
      updateActiveTreeItem(safeNew);
    }
  } catch (err) {
    showToast(`Rename failed: ${err.message}`, 'error');
  }
}


/* ════════════════════════════════════════════════════════════════
   MODE SWITCHING (Reading / Editing)
   ════════════════════════════════════════════════════════════════ */

function setMode(mode) {
  const btnReading       = document.getElementById('btn-reading');
  const btnEditing       = document.getElementById('btn-editing');
  const readingContainer = document.getElementById('reading-container');
  const editorContainer  = document.getElementById('editor-container');
  const readerPane       = document.getElementById('reader-pane');
  const welcomeState     = document.getElementById('welcome-state');
  const btnSave          = document.getElementById('btn-save');

  const isBinary = state.currentFile && !/\.(md|txt|csv|json|yaml|yml|py|js|ts|css|html|sh|bat|xml|ini)$/i.test(state.currentFile);
  if (isBinary && mode === 'editing') return; // Cannot edit binary files

  state.mode = mode;

  if (mode === 'reading') {
    // Current content is already kept up to date by editor on-change listeners.
    if (state.unsaved) {
      saveCurrentFile();
    }

    // Reading mode
    editorContainer.classList.add('hidden');
    editorContainer.classList.remove('flex');
    readingContainer.classList.remove('hidden');
    readingContainer.classList.add('flex');
    btnSave.classList.add('hidden');

    btnReading.classList.add('active-mode');
    btnEditing.classList.remove('active-mode');

    // Render markdown into reading pane
    if (state.currentFile) {
      const rendered = renderMarkdown(state.currentContent);
      readerPane.innerHTML = rendered;
      welcomeState.classList.add('hidden');
      readerPane.classList.remove('hidden');
    }
  } else {
    // Editing mode
    readingContainer.classList.add('hidden');
    readingContainer.classList.remove('flex');
    editorContainer.classList.remove('hidden');
    editorContainer.classList.add('flex');
    btnSave.classList.remove('hidden');

    btnReading.classList.remove('active-mode');
    btnEditing.classList.add('active-mode');

    if (window.CodeMirror) {
        if (!state.cmView) {
            state.cmView = CodeMirror.fromTextArea(document.getElementById('editor-textarea'), {
                mode: 'markdown',
                theme: 'material-darker',
                lineWrapping: true,
                viewportMargin: Infinity
            });
            state.cmView.on('change', (cm) => {
                state.currentContent = cm.getValue();
                state.unsaved = true;
                updateEditorStats();
                document.getElementById('save-status').textContent = 'Unsaved changes';
                document.getElementById('btn-save').classList.remove('hidden');
            });
        }
        if (state.cmView.getValue() !== state.currentContent) {
            state.cmView.setValue(state.currentContent);
            // Move cursor to top to avoid jumping
            state.cmView.setCursor(0, 0);
        }
        state.cmView.focus();
        // CM5 hides the original textarea automatically
    } else {
        const textarea = document.getElementById('editor-textarea');
        textarea.style.display = 'block';
        textarea.classList.add('flex-1');
        textarea.value = state.currentContent;
        textarea.focus();
        textarea.setSelectionRange(0, 0);
        textarea.scrollTop = 0;
    }
    updateEditorStats();
  }
}

function updateEditorContent() {
  if (!state.currentFile) return;

  const isBinary = !/\.(md|txt|csv|json|yaml|yml|py|js|ts|css|html|sh|bat|xml|ini)$/i.test(state.currentFile);
  const readerPane = document.getElementById('reader-pane');
  const textarea = document.getElementById('editor-textarea');
  const btnEditingMode = document.getElementById('btn-editing');
  
  if (isBinary) {
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(state.currentFile)) {
        readerPane.innerHTML = `<img src="/api/files/${encodeURIComponent(state.currentFile)}" class="max-w-full h-auto rounded-lg shadow-sm mx-auto mt-4" />`;
    } else if (/\.(mp4|webm)$/i.test(state.currentFile)) {
        readerPane.innerHTML = `<video src="/api/files/${encodeURIComponent(state.currentFile)}" controls class="max-w-full rounded-lg shadow-sm mx-auto mt-4"></video>`;
    } else if (/\.pdf$/i.test(state.currentFile)) {
        readerPane.innerHTML = `<iframe src="/api/files/${encodeURIComponent(state.currentFile)}" class="w-full h-[80vh] border-0 rounded-lg shadow-sm mt-4"></iframe>`;
    } else {
        readerPane.innerHTML = `<div class="p-8 text-center text-[var(--color-text-muted)] mt-12">
            <svg class="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
            </svg>
            <p>Binary file format not previewable.</p>
            <a href="/api/files/${encodeURIComponent(state.currentFile)}" download class="mt-4 inline-block px-4 py-2 bg-[var(--color-accent)] text-white rounded-md hover:bg-blue-600 transition-colors">Download File</a>
        </div>`;
    }
    textarea.value = '';
    textarea.disabled = true;
    if (btnEditingMode) btnEditingMode.style.display = 'none';
  } else {
    // Reading mode: render sanitized HTML
    const rendered = renderMarkdown(state.currentContent);
    readerPane.innerHTML = rendered;

    // Editor mode: raw text
    if (window.CodeMirror && state.cmView) {
        if (state.cmView.getValue() !== state.currentContent) {
            state.cmView.setValue(state.currentContent);
            state.cmView.setCursor(0, 0);
        }
    } else {
        textarea.style.display = 'block';
        textarea.classList.add('flex-1');
        textarea.value = state.currentContent;
    }
    textarea.disabled = false;
    if (btnEditingMode) btnEditingMode.style.display = 'flex';
  }
  updateEditorStats();
}

function showWelcomeState() {
  document.getElementById('welcome-state').classList.remove('hidden');
  document.getElementById('reader-pane').classList.add('hidden');
  document.getElementById('file-actions').classList.add('hidden');
  document.getElementById('file-actions').classList.remove('flex');
  document.getElementById('header-file-title').textContent = '';
  state.currentFile = null;
  state.currentContent = '';
}

function updateActiveTreeItem(filePath) {
  document.querySelectorAll('.tree-item[data-path]').forEach(el => {
    el.classList.toggle('active', el.dataset.path === filePath);
  });
}


/* ════════════════════════════════════════════════════════════════
   EDITOR HELPERS
   ════════════════════════════════════════════════════════════════ */

let debounceTimer = null;

function onEditorInput(e) {
  const textarea = document.getElementById('editor-textarea');
  if (textarea) {
    state.currentContent = textarea.value;
  }
  state.unsaved = true;
  updateEditorStats();
  setSaveStatus('Unsaved changes');

  // Auto-save debounce (800ms)
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (state.unsaved) saveCurrentFile();
  }, 800);
}

function onEditorKeydown(e) {
  // Ctrl+S / Cmd+S → Save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    clearTimeout(debounceTimer);
    saveCurrentFile();
  }
  // Escape → switch back to Reading mode
  if (e.key === 'Escape') {
    e.preventDefault();
    if (state.unsaved) {
      saveCurrentFile();
    } else {
      setMode('reading');
    }
  }
  // Tab → insert 2 spaces (not focus change)
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 2;
  }
}

function updateEditorStats() {
  const text = state.cmView ? state.cmView.getValue() : document.getElementById('editor-textarea').value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  document.getElementById('stat-words').textContent = `${words} word${words !== 1 ? 's' : ''}`;
  document.getElementById('stat-chars').textContent = `${text.length} chars`;
  document.getElementById('stat-lines').textContent = `${text.split('\n').length} lines`;
}

function setSaveStatus(msg) {
  const el = document.getElementById('save-status');
  if (el) el.textContent = msg;
}


/* ════════════════════════════════════════════════════════════════
   WEBSOCKET REAL-TIME SYNC
   ════════════════════════════════════════════════════════════════ */

let ws = null;
let wsReconnectTimer = null;

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  
  // Connect via activeToken if available, otherwise fallback to session cookie
  let url = `${protocol}//${location.host}/ws/sync`;
  if (activeToken) {
    url += `?token=${encodeURIComponent(activeToken)}`;
  }

  ws = new WebSocket(url);

  ws.onopen = () => {
    setWsStatus('connected');
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return; // Ignore non-JSON messages
    }
    // Validate message shape — no direct property access from msg without check
    if (!msg || typeof msg !== 'object') return;
    const evType = typeof msg.type === 'string' ? msg.type : '';
    const evPath = typeof msg.path === 'string' ? sanitizeFilePath(msg.path) : null;

    switch (evType) {
      case 'FILE_CHANGED':
        if (evPath === state.currentFile && state.mode === 'reading') {
          // Reload content if we're viewing this file in Reading mode
          openFile(evPath);
        }
        loadFileTree();
        break;
      case 'FILE_DELETED':
        if (evPath === state.currentFile) {
          showToast('The file you were viewing was deleted.', 'error');
          showWelcomeState();
        }
        loadFileTree();
        break;
      case 'FILE_RENAMED':
      case 'FOLDER_CREATED':
        loadFileTree();
        break;
    }
  };

  ws.onclose = () => {
    setWsStatus('offline');
    // Reconnect after 5 seconds
    wsReconnectTimer = setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = () => {
    setWsStatus('offline');
    ws.close();
  };
}

function setWsStatus(status) {
  const dot   = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  if (!dot) return;
  if (status === 'connected') {
    dot.style.background = '#22c55e';
    if (label) label.textContent = 'Live';
  } else {
    dot.style.background = '#555';
    if (label) label.textContent = 'Offline';
  }
}


/* ════════════════════════════════════════════════════════════════
   WIKILINK NAVIGATION
   ════════════════════════════════════════════════════════════════ */

function openWikilink(event, targetName) {
  event.preventDefault();
  // Find file by name (without extension) in the flat list
  const paths = state.treeData.map(f => typeof f === 'string' ? f : f.path);
  const match = paths.find(p => {
    const name = p.split('/').pop().replace(/\.md$/, '');
    return name.toLowerCase() === targetName.toLowerCase();
  });

  if (match) {
    openFile(match);
  } else {
    // Prompt to create new note
    showConfirmModal(
      'Note Not Found',
      `"${escapeHtml(targetName)}" doesn't exist yet. Create it?`,
      'Create Note', 'primary'
    ).then(confirmed => {
      if (confirmed) {
        const newPath = targetName.endsWith('.md') ? targetName : `${targetName}.md`;
        createFile(newPath, `# ${targetName}\n\n`);
      }
    });
  }
}


/* ════════════════════════════════════════════════════════════════
   SIDEBAR & LAYOUT
   ════════════════════════════════════════════════════════════════ */

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  document.getElementById('sidebar').classList.toggle('collapsed', !state.sidebarOpen);
}

// Resizable sidebar drag logic
(function initResizer() {
  const resizer  = document.getElementById('resizer');
  const sidebar  = document.getElementById('sidebar');
  let dragging   = false;
  let startX, startW;

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX   = e.clientX;
    startW   = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newW = Math.min(380, Math.max(180, startW + (e.clientX - startX)));
    sidebar.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();


/* ════════════════════════════════════════════════════════════════
   PROMPT MODALS
   ════════════════════════════════════════════════════════════════ */

function promptCreateFile() {
  showInputModal('New Note', 'Enter a name for the new note (e.g. "my-note.md" or "folder/note.md"):', 'New Note.md', 'Create')
    .then(name => {
      if (!name) return;
      const path = name.endsWith('.md') ? name : name + '.md';
      const safe = sanitizeFilePath(path);
      if (!safe) { showToast('Invalid file path.', 'error'); return; }
      createFile(safe, `# ${name.replace(/\.md$/, '')}\n\n`);
    });
}

function promptCreateFolder() {
  showInputModal('New Folder', 'Enter a name for the new folder:', 'New Folder', 'Create')
    .then(name => {
      if (!name) return;
      const safe = sanitizeFilePath(name);
      if (!safe) { showToast('Invalid folder name.', 'error'); return; }
      // Create a .gitkeep placeholder inside the folder via WebSocket FOLDER_CREATE
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'FOLDER_CREATE', path: safe }));
        showToast('Folder creation requested.', 'success');
        setTimeout(loadFileTree, 500);
      } else {
        showToast('WebSocket not connected. Cannot create folder.', 'error');
      }
    });
}

function promptRenameFile(filePath) {
  const path = filePath || state.currentFile;
  if (!path) return;
  const currentName = path.split('/').pop();
  showInputModal('Rename Note', 'Enter a new name:', currentName, 'Rename')
    .then(name => {
      if (!name || name === currentName) return;
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      const newPath = dir + (name.endsWith('.md') ? name : name + '.md');
      const safe = sanitizeFilePath(newPath);
      if (!safe) { showToast('Invalid file path.', 'error'); return; }
      renameFile(path, safe);
    });
}


/* ════════════════════════════════════════════════════════════════
   MODAL & TOAST UI
   ════════════════════════════════════════════════════════════════ */

function showInputModal(title, message, defaultValue, confirmLabel = 'OK') {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-box">
        <h3 class="text-sm font-semibold text-on-surface mb-2">${escapeHtml(title)}</h3>
        <p class="text-xs text-muted mb-4">${escapeHtml(message)}</p>
        <input type="text" class="input w-full mb-4" id="modal-input" value="${escapeHtml(defaultValue)}" />
        <div class="flex gap-2 justify-end">
          <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.getElementById('modal-root').appendChild(backdrop);

    const input   = backdrop.querySelector('#modal-input');
    const cancel  = backdrop.querySelector('#modal-cancel');
    const confirm = backdrop.querySelector('#modal-confirm');

    input.focus();
    input.select();

    const cleanup = () => backdrop.remove();

    cancel.onclick  = () => { cleanup(); resolve(null); };
    confirm.onclick = () => { cleanup(); resolve(input.value.trim()); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter')  { cleanup(); resolve(input.value.trim()); }
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    };
    backdrop.onclick = (e) => { if (e.target === backdrop) { cleanup(); resolve(null); } };
  });
}

function showConfirmModal(title, message, confirmLabel = 'Confirm', variant = 'danger') {
  return new Promise(resolve => {
    const btnClass = variant === 'danger' ? 'btn-danger' : 'btn-primary';
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-box">
        <h3 class="text-sm font-semibold text-on-surface mb-2">${escapeHtml(title)}</h3>
        <p class="text-xs text-muted mb-5">${escapeHtml(message)}</p>
        <div class="flex gap-2 justify-end">
          <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
          <button class="btn ${btnClass}" id="modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.getElementById('modal-root').appendChild(backdrop);

    const cancel  = backdrop.querySelector('#modal-cancel');
    const confirm = backdrop.querySelector('#modal-confirm');

    confirm.focus();
    cancel.onclick  = () => { backdrop.remove(); resolve(false); };
    confirm.onclick = () => { backdrop.remove(); resolve(true); };
    backdrop.onclick = (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } };
  });
}

function showToast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  const el   = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;

  const icon = document.createElement('span');
  icon.textContent = type === 'error' ? '✗' : type === 'success' ? '✓' : 'ℹ';
  icon.style.opacity = '0.7';

  const text = document.createElement('span');
  text.textContent = message; // XSS safe: textContent (CWE-79)

  el.appendChild(icon);
  el.appendChild(text);
  root.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(10px)';
    el.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => el.remove(), 250);
  }, 3500);
}


/* ════════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  // Attach CSP-compliant event listeners
  document.getElementById('sidebar-toggle')?.addEventListener('click', toggleSidebar);
  document.getElementById('tree-search')?.addEventListener('input', (e) => filterTree(e.target.value));
  document.getElementById('btn-new-note')?.addEventListener('click', promptCreateFile);
  document.getElementById('btn-new-folder')?.addEventListener('click', promptCreateFolder);
  document.getElementById('btn-refresh-tree')?.addEventListener('click', loadFileTree);
  document.getElementById('btn-reading')?.addEventListener('click', () => setMode('reading'));
  document.getElementById('btn-editing')?.addEventListener('click', () => setMode('editing'));
  document.getElementById('btn-save')?.addEventListener('click', saveCurrentFile);

  const textarea = document.getElementById('editor-textarea');
  if (textarea) {
    textarea.addEventListener('input', onEditorInput);
    textarea.addEventListener('keydown', onEditorKeydown);
  }

  // Delegated wikilink click handler in reading pane
  document.getElementById('reader-pane')?.addEventListener('click', (e) => {
    const link = e.target.closest('a.wikilink');
    if (link) {
      e.preventDefault();
      const target = link.dataset.target;
      if (target) {
        const cleanPath = target.endsWith('.md') ? target : `${target}.md`;
        openFile(cleanPath);
      }
    }
  });

  // Show vault path in sidebar header
  const vaultLabel = document.getElementById('vault-label');
  if (vaultLabel) vaultLabel.textContent = VAULT_PATH.split('/').pop();

  // Keyboard shortcut: Ctrl+E / Cmd+E → toggle edit mode
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      if (!state.currentFile) return;
      setMode(state.mode === 'reading' ? 'editing' : 'reading');
    }
  });

  // Try to get an active token for WS + file API calls
  // NOTE: Since /app uses session auth, API calls will work without a Bearer token
  // via session cookie. WS requires a token — show status accordingly.
  try {
    const res = await fetch('/dashboard/tokens');
    if (res.ok) {
      const data = await res.json();
      // token_prefix only stored — inform user if no tokens exist
      if (!data.tokens || data.tokens.length === 0) {
        showToast('No API tokens configured. Create one in the Dashboard to enable real-time sync.', 'info');
      }
    }
  } catch {}

  // Load the file tree
  await loadFileTree();

  // Connect WS (will use session cookie if no activeToken is available)
  connectWebSocket();
});
