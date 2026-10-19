import * as Sparql from "./sparql.js";

const searchInput = document.getElementById("search-input");
const suggestionsEl = document.getElementById("suggestions");
const contentEl = document.getElementById("content");
const graphFilterEl = document.getElementById("graph-filter");
const graphFilterSummary = document.getElementById("graph-filter-summary");
const graphFilterList = document.getElementById("graph-filter-list");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// This deployment's SPARQL endpoint (from config.json) - fixed, not
// user-switchable. Set once in boot() before anything else runs.
let ENDPOINT = null;

// --- graph filter state -------------------------------------------------------

let allGraphs = [];          // [{iri, short, count}], loaded once from Sparql.listGraphs
let selectedGraphs = [];     // array of graph IRIs currently filtered to (empty = all)

function graphsFromLocation() {
  const raw = new URLSearchParams(window.location.search).get("graph");
  if (!raw) return [];
  return raw.split(",").filter(Boolean);
}

// Builds a "?iri=...&graph=..." page URL (manual encoding throughout,
// rather than mixing in URLSearchParams.set() - that would double-encode
// values that are already percent-encoded).
function buildPageUrl(iri, graphs) {
  const parts = [];
  if (iri) parts.push("iri=" + encodeURIComponent(iri));
  if (graphs && graphs.length) parts.push("graph=" + graphs.map(encodeURIComponent).join(","));
  return parts.length ? "?" + parts.join("&") : "?";
}

function updateGraphFilterSummary() {
  if (selectedGraphs.length === 0) graphFilterSummary.textContent = "All graphs";
  else if (selectedGraphs.length === 1) {
    const g = allGraphs.find((x) => x.iri === selectedGraphs[0]);
    graphFilterSummary.textContent = g ? g.short : "1 graph";
  } else {
    graphFilterSummary.textContent = `${selectedGraphs.length} graphs`;
  }
}

function renderGraphFilterList() {
  graphFilterList.innerHTML = allGraphs.map((g) => `
    <li>
      <label>
        <input type="checkbox" value="${escapeHtml(g.iri)}" ${selectedGraphs.includes(g.iri) ? "checked" : ""}>
        <span class="g-short" title="${escapeHtml(g.iri)}">${escapeHtml(g.short)}</span>
        <span class="g-count">${g.count.toLocaleString()}</span>
      </label>
    </li>
  `).join("");
}

async function loadGraphList() {
  try {
    allGraphs = await Sparql.listGraphs(ENDPOINT);
    renderGraphFilterList();
    updateGraphFilterSummary();
  } catch (err) {
    graphFilterSummary.textContent = "Graphs unavailable";
  }
}

graphFilterList.addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  const checked = [...graphFilterList.querySelectorAll("input:checked")].map((cb) => cb.value);
  applyGraphFilter(checked);
});

document.getElementById("graph-filter-clear").addEventListener("click", () => applyGraphFilter([]));

function applyGraphFilter(graphs) {
  selectedGraphs = graphs;
  renderGraphFilterList();
  updateGraphFilterSummary();
  const iri = iriFromLocation();
  window.history.pushState({ iri, graphs }, "", buildPageUrl(iri, graphs));
  if (iri) loadResource(iri);
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("#graph-filter")) graphFilterEl.removeAttribute("open");
});

// --- navigation (shareable ?iri=/&graph= URL, back/forward support) ---------

function iriFromLocation() {
  return new URLSearchParams(window.location.search).get("iri");
}

function navigate(iri) {
  window.history.pushState(
    { iri, graphs: selectedGraphs }, "",
    buildPageUrl(iri, selectedGraphs)
  );
  loadResource(iri);
}

window.addEventListener("popstate", () => {
  selectedGraphs = graphsFromLocation();
  renderGraphFilterList();
  updateGraphFilterSummary();
  const iri = iriFromLocation();
  if (iri) loadResource(iri);
  else showEmptyState();
});

// Event delegation: any element with data-nav-iri navigates on click.
contentEl.addEventListener("click", (e) => {
  const el = e.target.closest("[data-nav-iri]");
  if (!el) return;
  e.preventDefault();
  navigate(el.getAttribute("data-nav-iri"));
});

// --- search / autosuggest ----------------------------------------------------

let activeIndex = -1;
let currentMatches = [];

const fetchSuggestions = debounce(async (q) => {
  if (!q) {
    hideSuggestions();
    return;
  }
  try {
    currentMatches = await Sparql.suggest(q, selectedGraphs.length ? selectedGraphs : null, ENDPOINT);
    renderSuggestions(currentMatches);
  } catch (err) {
    hideSuggestions();
  }
}, 250);

function renderSuggestions(matches) {
  activeIndex = -1;
  if (!matches.length) {
    hideSuggestions();
    return;
  }
  suggestionsEl.innerHTML = matches.map((m, i) => `
    <li data-index="${i}" data-iri="${escapeHtml(m.iri)}">
      <span class="s-label">${escapeHtml(m.label)}</span>
      <span class="s-curie">${escapeHtml(m.curie || m.iri)}</span>
    </li>
  `).join("");
  suggestionsEl.hidden = false;
}

function hideSuggestions() {
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentMatches = [];
  activeIndex = -1;
}

suggestionsEl.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-iri]");
  if (!li) return;
  searchInput.value = "";
  hideSuggestions();
  navigate(li.getAttribute("data-iri"));
});

searchInput.addEventListener("input", () => fetchSuggestions(searchInput.value.trim()));

searchInput.addEventListener("keydown", (e) => {
  const items = suggestionsEl.querySelectorAll("li");
  if (e.key === "ArrowDown" && items.length) {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, items.length - 1);
    items.forEach((li, i) => li.classList.toggle("active", i === activeIndex));
  } else if (e.key === "ArrowUp" && items.length) {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    items.forEach((li, i) => li.classList.toggle("active", i === activeIndex));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeIndex >= 0 && currentMatches[activeIndex]) {
      searchInput.value = "";
      hideSuggestions();
      navigate(currentMatches[activeIndex].iri);
    } else {
      const raw = searchInput.value.trim();
      if (/^https?:\/\//i.test(raw)) {
        searchInput.value = "";
        hideSuggestions();
        navigate(raw);
      }
    }
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-box")) hideSuggestions();
});

// --- resource rendering ------------------------------------------------------

function renderGraphBadges(graphs) {
  if (!graphs || !graphs.length) return "";
  return `<span class="graph-badges">${graphs.map((g) =>
    `<span class="graph-badge" title="${escapeHtml(g.iri)}">${escapeHtml(g.short)}</span>`
  ).join("")}</span>`;
}

const MANCHESTER_KEYWORDS = /\b(some|only|value|min|max|exactly|and|or|not)\b/g;

function formatManchester(text) {
  // Escape first, then bold known keywords - safe because the keyword list
  // contains no HTML-special characters, so matching post-escape is
  // equivalent to matching pre-escape.
  return escapeHtml(text).replace(MANCHESTER_KEYWORDS, "<strong>$1</strong>");
}

function navLink(iri, text, extraAttrs = "") {
  return `<a href="?iri=${encodeURIComponent(iri)}" data-nav-iri="${escapeHtml(iri)}" title="${escapeHtml(iri)}" ${extraAttrs}>${escapeHtml(text)}</a>`;
}

function renderUriNode(node) {
  const text = node.label || node.curie || node.iri;
  const sub = node.label ? (node.curie || "") : "";
  return `<span class="obj-item">${navLink(node.iri, text)}${sub ? navLink(node.iri, sub, 'class="obj-curie"') : ""}${renderGraphBadges(node.graphs)}</span>`;
}

function renderLiteralNode(node) {
  const badge = node.lang ? `@${node.lang}` : (node.datatype ? node.datatype : "");
  return `<span class="obj-item">${escapeHtml(node.value)}${badge ? `<span class="literal-badge">${escapeHtml(badge)}</span>` : ""}${renderGraphBadges(node.graphs)}</span>`;
}

function renderPredLink(p) {
  return navLink(p.iri, p.label || p.curie || p.iri);
}

function renderBnodeNode(node) {
  let inner = "";
  if (node.properties && node.properties.length) {
    // Outgoing blank node: show its own properties one level deep (e.g. an
    // OWL restriction's onProperty/someValuesFrom/cardinality).
    inner = node.properties.map((e) => `
      <div class="bnode-row">
        ${renderPredLink(e.predicate)}
        <span class="bnode-arrow">&rarr;</span>
        ${renderNode(e.value)}
      </div>
    `).join("");
  } else if (node.parents && node.parents.length) {
    // Incoming blank node: we can't navigate to it directly (its identifier
    // isn't portably re-queryable), so show what points to it instead -
    // usually the real resource it's providing structure for.
    inner = node.parents.map((e) => `
      <div class="bnode-row">
        <span class="bnode-of">part of, via</span>
        ${renderPredLink(e.predicate)}
        <span class="bnode-of">of</span>
        ${renderNode(e.value)}
      </div>
    `).join("");
  }

  // rdf:type / rdfs:subClassOf blank-node values get a Manchester-syntax
  // rendering (a readable class expression) as the headline, with the raw
  // one-level property dump tucked behind a disclosure for anyone who wants
  // to see exactly what was fetched.
  if (node.manchester) {
    const raw = inner ? `<details class="manchester-raw"><summary>raw</summary><div class="bnode-box">${inner}</div></details>` : "";
    return `<span class="obj-item bnode"><code class="manchester">${formatManchester(node.manchester)}</code>${renderGraphBadges(node.graphs)}${raw}</span>`;
  }

  return `<span class="obj-item bnode"><span class="bnode-label">(anonymous node)</span>${renderGraphBadges(node.graphs)}${inner ? `<div class="bnode-box">${inner}</div>` : ""}</span>`;
}

function renderNode(node) {
  if (node.kind === "uri") return renderUriNode(node);
  if (node.kind === "bnode") return renderBnodeNode(node);
  return renderLiteralNode(node);
}

function renderPredGroup(group, objectsKey, isIncoming) {
  const p = group.predicate;
  const label = p.label || p.curie || p.iri;
  // In "Referenced by", the predicate reads in the opposite direction from
  // "Properties" (it's ?s <p> THIS, not THIS <p> ?o) - spelling that out as
  // 'is "label" of' instead of a bare label avoids misreading it as if this
  // resource were the subject of the relation.
  const linkText = isIncoming ? `is &ldquo;${escapeHtml(label)}&rdquo; of` : escapeHtml(label);
  const objects = group[objectsKey].map(renderNode).join("");
  return `
    <div class="pred-group">
      <div class="pred-name">
        <a href="?iri=${encodeURIComponent(p.iri)}" data-nav-iri="${escapeHtml(p.iri)}" title="${escapeHtml(p.iri)}">${linkText}</a>
        ${p.label && p.curie ? navLink(p.iri, p.curie, 'class="pred-curie"') : ""}
      </div>
      <div class="obj-list">${objects}</div>
    </div>
  `;
}

function buildExampleQuery(iri, graphs) {
  if (graphs && graphs.length) {
    const values = graphs.map((g) => `<${g}>`).join(" ");
    return `SELECT DISTINCT ?g ?p ?o WHERE {\n  VALUES ?g { ${values} }\n  GRAPH ?g { <${iri}> ?p ?o }\n} ORDER BY ?p LIMIT 100`;
  }
  return `SELECT DISTINCT ?p ?o WHERE {\n  <${iri}> ?p ?o\n} ORDER BY ?p LIMIT 100`;
}

function renderEmptyWithFilter(data) {
  contentEl.innerHTML = `
    <div class="resource-header">
      <div class="resource-title no-label">${escapeHtml(data.curie || data.iri)}</div>
      <div class="resource-iri-row">
        <span class="resource-iri">${escapeHtml(data.iri)}</span>
      </div>
    </div>
    <div class="empty-filtered">
      <p>No data found for this resource in the selected graph(s).</p>
      <div class="empty-filtered-actions">
        <button id="clear-filter-btn">Clear graph filter</button>
        <button id="focus-search-btn">Search for something else</button>
      </div>
      <div id="graph-examples-box"><p class="loading">Loading examples from the selected graph(s)...</p></div>
    </div>
  `;

  document.getElementById("clear-filter-btn").addEventListener("click", () => applyGraphFilter([]));
  document.getElementById("focus-search-btn").addEventListener("click", () => searchInput.focus());

  loadGraphExamples();
}

async function loadGraphExamples() {
  const box = document.getElementById("graph-examples-box");
  if (!box) return;
  try {
    const data = await Sparql.graphExamples(selectedGraphs, ENDPOINT);
    const classesHtml = (data.classes || []).map((c) => `
      <li>${navLink(c.iri, c.label || c.curie || c.iri)} <span class="example-count">${c.count.toLocaleString()}</span></li>
    `).join("");
    const resourcesHtml = (data.resources || []).map((r) => `
      <li>${navLink(r.iri, r.label || r.curie || r.iri)}</li>
    `).join("");
    box.innerHTML = (classesHtml || resourcesHtml) ? `
      ${classesHtml ? `<div class="example-group"><h3>Example classes in this graph</h3><ul>${classesHtml}</ul></div>` : ""}
      ${resourcesHtml ? `<div class="example-group"><h3>Example resources in this graph</h3><ul>${resourcesHtml}</ul></div>` : ""}
    ` : `<p class="truncated-note">No labeled resources found in the selected graph(s) either.</p>`;
  } catch (err) {
    box.innerHTML = `<p class="truncated-note">Could not load examples: ${escapeHtml(err.message)}</p>`;
  }
}

function renderResource(data) {
  const isEmpty = (data.outgoing || []).length === 0 && (data.incoming || []).length === 0
    && (data.types || []).length === 0;
  if (isEmpty && selectedGraphs.length > 0) {
    return renderEmptyWithFilter(data);
  }

  const title = data.label || data.curie || data.iri;
  const titleClass = data.label ? "resource-title" : "resource-title no-label";

  // data.types is ordered most-general-first (see orderTypesByHierarchy in
  // sparql.js) - indent each line a little further than the last so the
  // more specific a type is, the more it's nested under its ancestors.
  const types = data.types || [];
  const typeChips = types.map((t, i) => {
    const mostSpecific = i === types.length - 1;
    return `
    <a class="chip${mostSpecific ? " chip-most-specific" : ""}" style="margin-left: ${i * 0.6}rem" href="?iri=${encodeURIComponent(t.iri)}" data-nav-iri="${escapeHtml(t.iri)}" title="${escapeHtml(t.iri)}">${escapeHtml(t.label || t.curie || t.iri)}${renderGraphBadges(t.graphs)}</a>
  `;
  }).join("");

  const outgoing = (data.outgoing || []).map((g) => renderPredGroup(g, "objects", false)).join("")
    || `<p class="truncated-note">No outgoing properties${selectedGraphs.length ? " in the selected graph(s)" : ""}.</p>`;
  const incoming = (data.incoming || []).map((g) => renderPredGroup(g, "subjects", true)).join("")
    || `<p class="truncated-note">Nothing else references this resource${selectedGraphs.length ? " in the selected graph(s)" : ""}.</p>`;

  // Ancestors via config's "part of" predicate (see fetchPartOfChain in
  // sparql.js), root-first, not including this resource itself - its own
  // title right below already covers that.
  const breadcrumb = data.breadcrumb || [];
  const breadcrumbHtml = breadcrumb.length ? `
    <nav class="breadcrumb" aria-label="Part-of hierarchy">
      ${breadcrumb.map((b) => navLink(b.iri, b.label || b.curie || b.iri, 'class="breadcrumb-item"')).join('<span class="breadcrumb-sep">&rsaquo;</span>')}
    </nav>
  ` : "";

  contentEl.innerHTML = `
    <div class="resource-header">
      ${breadcrumbHtml}
      <div class="${titleClass}">${escapeHtml(title)}</div>
      <div class="resource-iri-row">
        <span class="resource-iri">${escapeHtml(data.iri)}</span>
        <button class="copy-link-btn" id="copy-link-btn">Copy link</button>
        <button class="copy-link-btn" id="open-editor-btn" title="Open this resource's properties as a query in the endpoint's own SPARQL editor">Open in SPARQL editor</button>
      </div>
      ${typeChips ? `<div class="type-chips">${typeChips}</div>` : ""}
    </div>

    <section class="rel-section">
      <h2>Properties (${(data.outgoing || []).length})</h2>
      ${outgoing}
      ${data.outgoing_truncated ? `<p class="truncated-note">Hit the row cap - some values may be omitted. Try narrowing the graph filter.</p>` : ""}
    </section>

    <section class="rel-section">
      <h2>Referenced by (${(data.incoming || []).length})</h2>
      ${incoming}
      ${data.incoming_truncated ? `<p class="truncated-note">Hit the row cap - some references may be omitted. Try narrowing the graph filter.</p>` : ""}
    </section>
  `;

  document.getElementById("copy-link-btn").addEventListener("click", () => {
    const url = window.location.origin + window.location.pathname + buildPageUrl(data.iri, selectedGraphs);
    navigator.clipboard?.writeText(url).catch(() => {});
    const btn = document.getElementById("copy-link-btn");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1200);
  });

  document.getElementById("open-editor-btn").addEventListener("click", () => {
    if (!ENDPOINT) return;
    const query = buildExampleQuery(data.iri, selectedGraphs);
    window.open(`${ENDPOINT}?qtxt=${encodeURIComponent(query)}`, "_blank", "noopener");
  });
}

function showEmptyState() {
  contentEl.innerHTML = `
    <div id="empty-state">
      <p>Search for a resource above, or open a direct link like <code>?iri=&lt;IRI&gt;</code>.</p>
    </div>
  `;
}

function showLoading() {
  contentEl.innerHTML = `<p class="loading">Loading...</p>`;
}

function showError(message) {
  contentEl.innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
}

async function loadResource(iri) {
  showLoading();
  try {
    const data = await Sparql.fetchResource(iri, selectedGraphs.length ? selectedGraphs : null, ENDPOINT);
    renderResource(data);
  } catch (err) {
    showError(err.message || `Network error: ${err}`);
  }
}

// --- init ---------------------------------------------------------------------
// Called once config.json has loaded so the default endpoint/title/etc. are
// already known before the first data fetch goes out.

function initApp() {
  selectedGraphs = graphsFromLocation();
  loadGraphList();

  const initialIri = iriFromLocation();
  if (initialIri) loadResource(initialIri);
  else showEmptyState();
}

async function boot() {
  let config;
  try {
    config = await Sparql.loadConfig();
  } catch (e) {
    config = Sparql.getConfig();
  }

  ENDPOINT = config.endpoint;
  if (config.title) {
    document.title = config.title;
    const h1 = document.querySelector("header h1");
    if (h1) h1.textContent = config.title;
  }
  const footerEl = document.getElementById("site-footer");
  const impressumLink = document.getElementById("impressum-link");
  if (footerEl && impressumLink && config.impressum_url) {
    impressumLink.href = config.impressum_url;
    impressumLink.textContent = config.impressum_label || "Impressum";
    footerEl.hidden = false;
  }

  initApp();
}

boot();
