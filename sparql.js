// sparql.js - SPARQL 1.1 Protocol client + RDF/OWL processing logic.
//
// This is the "backend" of the SPARQL Data Navigator, ported to run entirely
// in the browser so the whole app can be hosted as static files (e.g. on
// GitHub Pages) with no server at all. It is a close, deliberate port of the
// Python server.py from the server-backed version this was forked from -
// same function names and structure where practical, so the two stay easy
// to compare.
//
// The one real consequence of dropping the backend: queries now go straight
// from this browser to whatever SPARQL endpoint is configured, which only
// works if THAT endpoint sends CORS headers (Access-Control-Allow-Origin).
// Most public SPARQL endpoints do (Virtuoso enables it by default, as do
// Wikidata, DBpedia, and others meant for public querying) - this app's own
// default endpoint and the SHMARQL one used during development both do -
// but an arbitrary one might not, and there is no way around that from a
// purely static site. See README.md.

export class SparqlError extends Error {}

// --- config ------------------------------------------------------------------
// Everything deployment-specific lives in config.json (fetched once, at
// startup) rather than hardcoded here - see README.md.

const DEFAULT_CONFIG = {
  title: "SPARQL Data Navigator",
  endpoint: "",
  namespaces_file: "data/namespaces.json",
  graph_short_prefix: "",
  // A sane starting point for a Virtuoso-backed endpoint (its own built-in
  // system/vocabulary graphs, not part of any actual dataset); harmless to
  // leave as-is against a non-Virtuoso endpoint, which simply won't have
  // graphs under these IRIs. Override per-deployment in config.json.
  excluded_graphs: [
    "http://www.openlinksw.com/schemas/virtrdf#",
    "http://localhost:8890/DAV/",
    "http://www.w3.org/2002/07/owl#",
    "urn:core:services:sparql",
    "http://www.w3.org/ns/ldp#",
    "urn:activitystreams-owl:map",
  ],
  label_lang_preference: [null, "en"],
  // Universal OWL vocabulary terms that are technically a type of nearly
  // every resource but never informative to show - not project-specific,
  // so a sane default for any OWL-based endpoint; override/empty this in
  // config.json for a deployment that wants them.
  excluded_types: [
    "http://www.w3.org/2002/07/owl#Thing",
    "http://www.w3.org/2002/07/owl#NamedIndividual",
  ],
  // The "part of" predicate (object pointing from a part to its whole) used
  // to build a breadcrumb trail on a resource page - empty (the default)
  // disables the feature entirely. This is dataset-specific (there's no
  // universal RDF/OWL "part of"), so it's opt-in via config.json rather than
  // a built-in default - e.g. BFO's "part of" (obo:BFO_0000050) for an
  // endpoint that uses it.
  part_of_predicate: "",
  // Its inverse, "has part" (e.g. BFO's obo:BFO_0000051) - not used for the
  // breadcrumb walk itself, only so the two can be pinned next to each
  // other in a resource's Properties list (see predicateSortKey) instead of
  // wherever they'd otherwise land alphabetically among everything else.
  // Deliberately configurable rather than hardcoded - which vocabulary term
  // a given deployment's data actually uses for this can change.
  has_part_predicate: "",
  impressum_url: "",
  impressum_label: "Impressum",
};

let CONFIG = { ...DEFAULT_CONFIG };
let NAMESPACES = {};
let NAMESPACES_BY_LEN = [];

export async function loadConfig() {
  try {
    const resp = await fetch("config.json");
    if (resp.ok) CONFIG = { ...DEFAULT_CONFIG, ...(await resp.json()) };
  } catch (_) {
    // no config.json shipped - the built-in (endpoint-less) defaults are a
    // legitimate starting point, not an error.
  }
  try {
    const resp = await fetch(CONFIG.namespaces_file);
    NAMESPACES = resp.ok ? await resp.json() : {};
  } catch (_) {
    NAMESPACES = {};
  }
  // Longer namespace IRIs must be tried before shorter ones that are
  // prefixes of them, so curie() always picks the most specific match.
  NAMESPACES_BY_LEN = Object.entries(NAMESPACES).sort((a, b) => b[1].length - a[1].length);
  return CONFIG;
}

export function getConfig() {
  return CONFIG;
}

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const OWL_NS = "http://www.w3.org/2002/07/owl#";
const RDFS_NS = "http://www.w3.org/2000/01/rdf-schema#";
const MANCHESTER_TRIGGER_PREDICATES = [RDF_NS + "type", RDFS_NS + "subClassOf"];
const CLASS_EXPR_DEPTH = 6; // bounded nesting depth for the Manchester-syntax closure fetch
const BREADCRUMB_MAX_DEPTH = 12; // bounded ancestor-walk depth for the "part of" breadcrumb

// Graph-scoped queries return one row per graph a triple appears in, so a
// triple duplicated across e.g. assertions/inferences/validated comes back
// 3x - raise the cap accordingly versus a plain deduplicated query.
const OUT_IN_LIMIT = 1500;
const LABEL_BATCH_SIZE = 40;

// --- low-level SPARQL HTTP client ---------------------------------------------

async function sparqlHttpFetch(endpoint, query, method, timeoutMs) {
  let url = endpoint;
  const headers = { Accept: "application/sparql-results+json" };
  let body;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams({ query }).toString();
  } else {
    const sep = endpoint.includes("?") ? "&" : "?";
    url = endpoint + sep + new URLSearchParams({ query }).toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new SparqlError(`Query timed out after ${timeoutMs / 1000}s`);
    }
    // A CORS rejection and a genuine network failure both surface as the
    // same opaque TypeError - browsers deliberately don't say which, for
    // security reasons - so the message below covers the likely cause.
    throw new SparqlError(
      `Could not reach endpoint (${e.message}). This app runs entirely in ` +
      `your browser, so it can only query endpoints that send CORS headers ` +
      `(Access-Control-Allow-Origin) - if you're sure the endpoint itself ` +
      `is up and the URL is correct, that's the likely reason.`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new SparqlError(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  return resp.text();
}

/** Run a SPARQL query against `endpoint`, return the raw parsed SPARQL-JSON
 * (bindings keep their full {type, value, lang?, datatype?} shape - not
 * flattened - since the browser needs to distinguish URIs from literals
 * from blank nodes). Tries POST first, falls back to GET on HTTP 405 - some
 * endpoints (e.g. SHMARQL) only implement the GET form of the SPARQL 1.1
 * Protocol. */
export async function sparqlQueryRaw(query, endpoint, timeoutMs = 30000) {
  if (!endpoint) throw new SparqlError("No SPARQL endpoint configured - set one in the header above.");
  let body;
  try {
    body = await sparqlHttpFetch(endpoint, query, "POST", timeoutMs);
  } catch (e) {
    if (!(e instanceof SparqlError) || !e.message.startsWith("HTTP 405")) throw e;
    body = await sparqlHttpFetch(endpoint, query, "GET", timeoutMs);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new SparqlError(`Non-JSON response: ${body.slice(0, 300)}`);
  }
}

// --- small helpers -------------------------------------------------------------

export function curie(iri) {
  for (const [prefix, ns] of NAMESPACES_BY_LEN) {
    if (iri.startsWith(ns)) return `${prefix}:${iri.slice(ns.length)}`;
  }
  return null;
}

/** A concise display name for a graph IRI. The full IRI is always available
 * separately (e.g. as a tooltip). */
export function shortGraphName(iri) {
  const prefix = CONFIG.graph_short_prefix;
  if (prefix && iri.startsWith(prefix)) {
    return iri.slice(prefix.length).replace(/\/+$/, "") || "/";
  }
  const sepIdx = iri.indexOf("://");
  const rest = (sepIdx === -1 ? iri : iri.slice(sepIdx + 3)).replace(/\/+$/, "");
  const parts = rest.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : rest;
}

function sparqlEscapeString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function* batched(seq, size) {
  for (let i = 0; i < seq.length; i += size) yield seq.slice(i, i + size);
}

/** True if every one of these SPARQL variables is present in this binding.
 * Guards every binding-processing loop below against an endpoint that
 * doesn't honor a query's exact shape (e.g. a custom front-end that ignores
 * query params it doesn't recognize and returns some unrelated default
 * result instead of erroring) - such a response has bindings missing vars
 * this code otherwise assumes are always there. */
function bound(b, ...keys) {
  return keys.every((k) => k in b);
}

// --- graph listing -------------------------------------------------------------

export async function listGraphs(endpoint) {
  const data = await sparqlQueryRaw(
    "SELECT DISTINCT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY DESC(?n)",
    endpoint
  );
  const excluded = new Set(CONFIG.excluded_graphs);
  const graphs = [];
  for (const b of data.results.bindings) {
    if (!bound(b, "g", "n")) continue;
    const iri = b.g.value;
    if (excluded.has(iri)) continue;
    graphs.push({ iri, short: shortGraphName(iri), count: parseInt(b.n.value, 10) });
  }
  return graphs;
}

// The implicit graph scope when no explicit filter is picked: every real
// dataset graph. Cached per endpoint for the page's lifetime.
const defaultGraphsCache = new Map(); // endpoint -> [iri, ...]

async function getDefaultGraphs(endpoint) {
  if (!defaultGraphsCache.has(endpoint)) {
    const graphs = await listGraphs(endpoint);
    defaultGraphsCache.set(endpoint, graphs.map((g) => g.iri));
  }
  return defaultGraphsCache.get(endpoint);
}

async function graphValuesClause(graphs, endpoint) {
  const gs = graphs && graphs.length ? graphs : await getDefaultGraphs(endpoint);
  const vals = gs.map((g) => `<${g}>`).join(" ");
  return `VALUES ?g { ${vals} }\n  `;
}

// --- label resolution ----------------------------------------------------------

/** Batch-fetch rdfs:label / skos:prefLabel for a set of IRIs. Returns
 * {iri: label}, preferring a German-tagged label over an untagged one over
 * an English one over any other language, when more than one is available
 * (per config's label_lang_preference). IRIs with no label found are simply
 * absent from the result. */
export async function resolveLabels(iris, endpoint) {
  const uniqueIris = [...new Set([...iris].filter(Boolean))].sort();
  const byLang = new Map(); // iri -> Map(lang_or_null -> label)
  for (const chunk of batched(uniqueIris, LABEL_BATCH_SIZE)) {
    const values = chunk.map((i) => `<${i}>`).join(" ");
    const query = `
SELECT DISTINCT ?s ?label WHERE {
  VALUES ?s { ${values} }
  { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label }
  UNION
  { ?s <http://www.w3.org/2004/02/skos/core#prefLabel> ?label }
}
`;
    let data;
    try {
      data = await sparqlQueryRaw(query, endpoint);
    } catch (e) {
      continue;
    }
    for (const b of data.results?.bindings || []) {
      if (!bound(b, "s", "label")) continue;
      const s = b.s.value;
      const lang = b.label["xml:lang"] ?? null;
      if (!byLang.has(s)) byLang.set(s, new Map());
      const langs = byLang.get(s);
      if (!langs.has(lang)) langs.set(lang, b.label.value);
    }
  }

  const labels = {};
  for (const [s, langs] of byLang) {
    let chosen = null;
    for (const pref of CONFIG.label_lang_preference) {
      if (langs.has(pref)) { chosen = langs.get(pref); break; }
    }
    labels[s] = chosen !== null ? chosen : langs.values().next().value;
  }
  return labels;
}

// --- node/value rendering --------------------------------------------------------

/** Render one SPARQL-JSON binding value as a JSON-serializable node for the
 * UI: a clickable {kind:"uri",...}, a plain {kind:"literal",...}, or a
 * non-clickable {kind:"bnode"} (blank node identifiers aren't stably
 * re-queryable across separate requests, so they're shown but not
 * navigable). */
function describeNode(binding, labels) {
  const t = binding.type;
  if (t === "uri") {
    const iri = binding.value;
    return { kind: "uri", iri, curie: curie(iri), label: labels[iri] ?? null };
  }
  if (t === "bnode") {
    return { kind: "bnode", id: binding.value };
  }
  const node = { kind: "literal", value: binding.value };
  if ("xml:lang" in binding) node.lang = binding["xml:lang"];
  if ("datatype" in binding) node.datatype = curie(binding.datatype) || binding.datatype;
  return node;
}

/** Hashable key so the same value seen in several graphs collapses into one
 * entry with a merged graph list. Blank node identity is scoped to its
 * graph - the same bnode label string in two different graphs is not the
 * same node, so it must not be merged. */
function nodeIdentity(node, graph) {
  if (node.kind === "uri") return JSON.stringify(["uri", node.iri]);
  if (node.kind === "bnode") return JSON.stringify(["bnode", graph, node.id]);
  return JSON.stringify(["lit", node.value, node.lang ?? null, node.datatype ?? null]);
}

function predicateNode(iri, labels) {
  return { iri, curie: curie(iri), label: labels[iri] ?? null };
}

/** Sort key for ordering a resource's properties. Plain predicate IRIs sort
 * alphabetically as before, except: if both `has_part_predicate` and
 * `part_of_predicate` are configured, they're forced to sort immediately
 * adjacent to each other (at the position "has part" would normally fall),
 * since they're inverses and showing them next to each other makes a
 * resource's part-whole relationships easier to read at a glance - rather
 * than leaving them wherever they'd otherwise land among everything else. */
function predicateSortKey(p) {
  const { has_part_predicate, part_of_predicate } = CONFIG;
  if (has_part_predicate && part_of_predicate) {
    if (p === has_part_predicate) return has_part_predicate + "\u0000a";
    if (p === part_of_predicate) return has_part_predicate + "\u0000b";
  }
  return p;
}

/** Group (g, p, value) bindings by predicate, then by distinct value,
 * merging the set of graphs each (predicate, value) pair was found in.
 *
 * If `expand` is given as [predCol, valCol, fieldName], any blank-node
 * value that has those extra columns bound gets a one-level expansion
 * attached under `fieldName`: a list of {predicate, value} pairs built from
 * those columns (used both for "this bnode's own properties", when valCol
 * is the bnode's object, and for "what points to this bnode", when valCol
 * is the bnode's parent - the shape is the same either way). */
function groupWithGraphs(bindings, valueKey, labels, expand) {
  const byPred = new Map(); // predIri -> Map(identityKey -> {node, graphs:Set})
  const expansions = new Map(); // JSON([graph,bnodeId]) -> [{predicate, value}]

  for (const b of bindings) {
    if (!bound(b, "p", "g", valueKey)) continue;
    const p = b.p.value;
    const g = b.g.value;
    const node = describeNode(b[valueKey], labels);
    if (!byPred.has(p)) byPred.set(p, new Map());
    const bucket = byPred.get(p);
    const key = nodeIdentity(node, g);
    if (!bucket.has(key)) bucket.set(key, { node, graphs: new Set() });
    bucket.get(key).graphs.add(g);

    if (expand && node.kind === "bnode") {
      const [predCol, valCol] = expand;
      if (predCol in b && valCol in b) {
        const ek = JSON.stringify([g, node.id]);
        if (!expansions.has(ek)) expansions.set(ek, []);
        expansions.get(ek).push({
          predicate: predicateNode(b[predCol].value, labels),
          value: describeNode(b[valCol], labels),
        });
      }
    }
  }

  const fieldName = expand ? expand[2] : null;
  const result = [];
  const predicates = [...byPred.keys()].sort((a, b) => {
    const ka = predicateSortKey(a), kb = predicateSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const p of predicates) {
    const items = [];
    for (const entry of byPred.get(p).values()) {
      const node = { ...entry.node };
      node.graphs = [...entry.graphs]
        .map((g) => ({ iri: g, short: shortGraphName(g) }))
        .sort((a, b) => (a.short < b.short ? -1 : a.short > b.short ? 1 : 0));
      if (fieldName && node.kind === "bnode") {
        const g0 = entry.graphs.values().next().value;
        const ek = JSON.stringify([g0, node.id]);
        const seen = new Set();
        const uniq = [];
        for (const e of expansions.get(ek) || []) {
          const k = JSON.stringify([e.predicate.iri, nodeIdentity(e.value, g0)]);
          if (!seen.has(k)) { seen.add(k); uniq.push(e); }
        }
        node[fieldName] = uniq;
      }
      items.push(node);
    }
    result.push({ predicate: predicateNode(p, labels), items });
  }
  return result;
}

// --- Manchester syntax rendering for complex rdf:type / rdfs:subClassOf ----
//
// A blank-node class expression (an owl:Restriction, or a boolean combinator
// like intersectionOf/unionOf/complementOf/oneOf) can't be rendered usefully
// as a flat property list - Manchester syntax is the standard, readable way
// to express these. Standard SPARQL has no arbitrary-depth traversal that
// stops at named nodes, so this fetches a *bounded*-depth closure (deep
// enough for realistic nesting and modest rdf:list lengths - each list cell
// costs one level of depth, the same generic mechanism handles restriction
// nesting AND list traversal without special-casing either) in one query,
// then reconstructs a local blank-node graph and formats it recursively.
// Beyond CLASS_EXPR_DEPTH, an unresolved sub-expression renders as "(...)"
// rather than silently showing nothing.

/** For each rdf:type/rdfs:subClassOf value of `iri` that is a blank node,
 * fetch its structure up to CLASS_EXPR_DEPTH levels deep. Returns [edges,
 * extraIris]: `edges` maps a JSON([graph, blank-node-id]) key - blank node
 * identity is only meaningful within its own graph, the same label can
 * exist unrelatedly in several graphs on this endpoint - to its list of
 * [predicateIri, valueBinding] pairs; `extraIris` is every named IRI
 * encountered, for label resolution. */
async function fetchClassExpressionEdges(iri, graphs, endpoint) {
  const valuesClause = await graphValuesClause(graphs, endpoint);
  const predFilter = MANCHESTER_TRIGGER_PREDICATES.map((p) => `?p = <${p}>`).join(" || ");

  let nested = "";
  for (let i = CLASS_EXPR_DEPTH; i >= 1; i--) {
    const prev = i > 1 ? `?o${i - 1}` : "?o";
    const guard = i > 1 ? `FILTER(isBlank(${prev})) . ` : "";
    nested = ` OPTIONAL { ${guard}${prev} ?p${i} ?o${i} .${nested} }`;
  }
  const selectVars = Array.from({ length: CLASS_EXPR_DEPTH }, (_, i) => `?p${i + 1} ?o${i + 1}`).join(" ");

  const query = `
SELECT DISTINCT ?g ?o ${selectVars} WHERE {
  ${valuesClause}GRAPH ?g {
    <${iri}> ?p ?o .
    FILTER(${predFilter})
    FILTER(isBlank(?o))
    ${nested}
  }
}
`;
  const data = await sparqlQueryRaw(query, endpoint);

  const edges = new Map();
  const extraIris = new Set();
  for (const b of data.results.bindings) {
    if (!bound(b, "g", "o")) continue;
    const g = b.g.value;
    const chain = [b.o, ...Array.from({ length: CLASS_EXPR_DEPTH }, (_, i) => b[`o${i + 1}`])];
    const preds = [null, ...Array.from({ length: CLASS_EXPR_DEPTH }, (_, i) => b[`p${i + 1}`])];
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1], pred = preds[i], cur = chain[i];
      if (!prev || !pred || !cur) break;
      if (prev.type !== "bnode") break;
      const predIri = pred.value;
      extraIris.add(predIri);
      if (cur.type === "uri") extraIris.add(cur.value);
      const key = JSON.stringify([g, prev.value]);
      if (!edges.has(key)) edges.set(key, []);
      const bucket = edges.get(key);
      const curStr = JSON.stringify(cur);
      if (!bucket.some(([pi, cv]) => pi === predIri && JSON.stringify(cv) === curStr)) {
        bucket.push([predIri, cur]);
      }
    }
  }
  return [edges, extraIris];
}

/** Walk an rdf:first/rdf:rest chain starting at `head` (a binding), in
 * order, stopping at rdf:nil, an unresolved node, or a repeat (cycle
 * guard). */
function flattenRdfList(head, edges, graph) {
  const items = [];
  let cur = head;
  const seen = new Set();
  while (cur && cur.type === "bnode" && !seen.has(cur.value)) {
    seen.add(cur.value);
    const props = edges.get(JSON.stringify([graph, cur.value]));
    if (!props || !props.length) break;
    const pmap = new Map();
    for (const [pred, val] of props) {
      if (!pmap.has(pred)) pmap.set(pred, []);
      pmap.get(pred).push(val);
    }
    const firstVals = pmap.get(RDF_NS + "first");
    if (!firstVals) break;
    items.push(firstVals[0]);
    const restVals = pmap.get(RDF_NS + "rest");
    if (!restVals) break;
    const nxt = restVals[0];
    if (nxt.type === "uri" && nxt.value === RDF_NS + "nil") break;
    cur = nxt;
  }
  return items;
}

/** Recursively render a class-expression binding as a Manchester syntax
 * string. `binding` may be a named class (rendered by label/curie), a
 * literal (rendered as-is, for hasValue/cardinality fillers), or a blank
 * node (interpreted as a Restriction or boolean combinator via `edges`,
 * looked up as [graph, bnode-id] - see fetchClassExpressionEdges). */
function renderClassExpr(binding, edges, labels, graph, depth = 0) {
  if (binding.type === "uri") {
    const iri = binding.value;
    return labels[iri] || curie(iri) || iri;
  }
  if (binding.type === "literal") return binding.value;

  if (depth >= CLASS_EXPR_DEPTH) return "(...)"; // nesting exceeded the fetch depth - there may be more

  const props = edges.get(JSON.stringify([graph, binding.value]));
  if (!props || !props.length) {
    // The blank node itself has no properties at all in this graph - seen
    // in practice on this endpoint (dangling/incompletely-copied
    // restriction stubs in some state graphs) - distinct from hitting the
    // depth limit, so say so rather than implying truncation.
    return "(no data for this node in this graph)";
  }
  const pmap = new Map();
  for (const [pred, val] of props) {
    if (!pmap.has(pred)) pmap.set(pred, []);
    pmap.get(pred).push(val);
  }
  const first = (localName) => {
    const vals = pmap.get(OWL_NS + localName);
    return vals ? vals[0] : null;
  };
  const rec = (b) => renderClassExpr(b, edges, labels, graph, depth + 1);

  const typeVals = pmap.get(RDF_NS + "type") || [];
  const isRestriction = typeVals.some((v) => v.value === OWL_NS + "Restriction") || first("onProperty");
  if (isRestriction) {
    const onProp = first("onProperty");
    const propStr = onProp ? rec(onProp) : "(property unspecified)";
    for (const [kw, localName] of [["some", "someValuesFrom"], ["only", "allValuesFrom"], ["value", "hasValue"]]) {
      const filler = first(localName);
      if (filler) return `${propStr} ${kw} ${rec(filler)}`;
    }
    const onClass = first("onClass");
    for (const [localName, kw] of [
      ["cardinality", "exactly"], ["minCardinality", "min"], ["maxCardinality", "max"],
      ["qualifiedCardinality", "exactly"], ["minQualifiedCardinality", "min"], ["maxQualifiedCardinality", "max"],
    ]) {
      const n = first(localName);
      if (n) {
        const suffix = onClass ? ` ${rec(onClass)}` : "";
        return `${propStr} ${kw} ${n.value}${suffix}`;
      }
    }
    // onProperty is present but no recognized value-constraint predicate was
    // found - this is real (incomplete/dangling restriction data has shown
    // up repeatedly on this endpoint), not a fetch failure, so say so
    // plainly rather than guessing a keyword that was never asserted.
    return `${propStr} ... (restriction incomplete in this graph)`;
  }

  for (const [localName, joiner] of [["intersectionOf", " and "], ["unionOf", " or "]]) {
    const head = first(localName);
    if (head) {
      const items = flattenRdfList(head, edges, graph);
      if (!items.length) {
        // The list head itself has no rdf:first/rdf:rest data in this graph
        // - the same "dangling node" situation as an empty restriction,
        // just one hop further out (on the list rather than the
        // restriction/class itself).
        return `(${localName}: list has no data in this graph)`;
      }
      return "(" + items.map(rec).join(joiner) + ")";
    }
  }

  const complement = first("complementOf");
  if (complement) return `not ${rec(complement)}`;

  const oneOf = first("oneOf");
  if (oneOf) {
    const items = flattenRdfList(oneOf, edges, graph);
    if (!items.length) return "(oneOf: list has no data in this graph)";
    return "{" + items.map(rec).join(", ") + "}";
  }

  // Has properties, but none match a recognized OWL class-expression shape
  // (Restriction / intersectionOf / unionOf / complementOf / oneOf).
  return "(unrecognized expression)";
}

// --- type-hierarchy ordering -----------------------------------------------

/** Order a resource's rdf:type values most-general-first, using
 * rdfs:subClassOf relationships *among just this type set* (resolving the
 * whole ontology's hierarchy isn't needed - only whether these particular
 * few types relate to each other, e.g. an instance typed both with its own
 * class and, via inference, one of its superclasses). Types with no
 * subclass relation to any other type here keep alphabetical order - a
 * stable partial-order (topological) sort, not a strict total order, so the
 * common single/unrelated-types case is unaffected.
 *
 * Deliberately a *direct* subClassOf query, not the `+` transitive property
 * path: Virtuoso rejects `?sub subClassOf+ ?super` when both ends are bound
 * via VALUES ("transitive start not given" - it wants a single concrete
 * starting IRI, not a set). A plain topological sort over direct edges
 * alone already produces a transitively-correct order (no separate closure
 * step needed), and on endpoints that materialize the full closure as
 * direct triples anyway (e.g. a reasoner's "inferences" graph) this returns
 * exactly the same edges `+` would have. */
async function orderTypesByHierarchy(typeIris, graphs, endpoint) {
  typeIris = [...typeIris].sort();
  if (typeIris.length < 2) return typeIris;

  const valuesClause = await graphValuesClause(graphs, endpoint);
  const values = typeIris.map((t) => `<${t}>`).join(" ");
  const query = `
SELECT DISTINCT ?sub ?super WHERE {
  ${valuesClause}GRAPH ?g {
    VALUES ?sub { ${values} }
    VALUES ?super { ${values} }
    ?sub <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?super .
  }
  FILTER(?sub != ?super)
}
`;
  let bindings;
  try {
    bindings = (await sparqlQueryRaw(query, endpoint)).results.bindings;
  } catch (e) {
    return typeIris;
  }

  // edges[super] = {sub, ...} that must come after super; indegree[t] = how
  // many of this type's own (in-set) superclasses haven't been placed yet.
  const edges = new Map(typeIris.map((t) => [t, new Set()]));
  const indegree = new Map(typeIris.map((t) => [t, 0]));
  for (const b of bindings) {
    if (!bound(b, "sub", "super")) continue;
    const sub = b.sub.value, sup = b.super.value;
    if (edges.has(sub) && edges.has(sup) && !edges.get(sup).has(sub)) {
      edges.get(sup).add(sub);
      indegree.set(sub, indegree.get(sub) + 1);
    }
  }

  // Kahn's algorithm, alphabetical tie-break: repeatedly emit the
  // alphabetically-first type with indegree 0 (every in-set superclass of
  // it, if any, already emitted) - i.e. the most general type available
  // next. Types with no relation to anything else here have indegree 0 from
  // the start and no edges either, so they just come out in plain
  // alphabetical order relative to each other.
  const remaining = new Set(typeIris);
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter((t) => indegree.get(t) === 0).sort();
    if (!ready.length) {
      ordered.push(...[...remaining].sort()); // a cycle - shouldn't happen, don't hang if it does
      break;
    }
    const t = ready[0];
    ordered.push(t);
    remaining.delete(t);
    for (const sub of edges.get(t)) {
      if (indegree.has(sub)) indegree.set(sub, indegree.get(sub) - 1);
    }
  }
  return ordered;
}

// --- "part of" breadcrumb ---------------------------------------------------

/** Walk `config.part_of_predicate` upward from `iri` (a part -> its whole)
 * one hop at a time, returning the ancestor chain root-first (not including
 * `iri` itself - the page's own title already shows that). A node can have
 * more than one "part of" parent in this data (it isn't always a strict
 * tree - the same item can sit under more than one curriculum variant); this
 * picks one deterministically (alphabetically-first IRI, resolved in SPARQL
 * itself via ORDER BY + LIMIT 1) at each step rather than branching, since a
 * breadcrumb is inherently a single path. Bounded by BREADCRUMB_MAX_DEPTH
 * and a seen-set, in case of bad/cyclical data. */
async function fetchPartOfChain(iri, graphs, endpoint) {
  const predicate = CONFIG.part_of_predicate;
  if (!predicate) return [];
  const valuesClause = await graphValuesClause(graphs, endpoint);

  const chain = [];
  const seen = new Set([iri]);
  let current = iri;
  for (let i = 0; i < BREADCRUMB_MAX_DEPTH; i++) {
    const candidatesQuery = `
SELECT DISTINCT ?parent WHERE {
  ${valuesClause}GRAPH ?g {
    <${current}> <${predicate}> ?parent .
  }
}
`;
    let candidates;
    try {
      candidates = [...new Set(
        (await sparqlQueryRaw(candidatesQuery, endpoint)).results.bindings
          .filter((b) => bound(b, "parent"))
          .map((b) => b.parent.value)
      )];
    } catch (e) {
      break;
    }
    if (!candidates.length) break;

    // If `part_of_predicate` is (like BFO's) transitive and this endpoint
    // materializes that closure as direct triples (seen in practice here -
    // the same situation as rdfs:subClassOf elsewhere in this app), a single
    // hop can return several candidates: the true immediate parent AND one
    // or more distant ancestors reachable via a "shortcut" triple. Picking
    // one arbitrarily (e.g. alphabetically) would often jump straight past
    // real intermediate levels. Instead, among the candidates, drop any
    // that is itself the target of another candidate's "part of" edge (i.e.
    // is reachable *through* another candidate) - what's left is the
    // immediate step(s); alphabetical order breaks any remaining tie.
    let nearest = candidates[0];
    if (candidates.length > 1) {
      const values = candidates.map((c) => `<${c}>`).join(" ");
      const relQuery = `
SELECT DISTINCT ?sub ?super WHERE {
  ${valuesClause}GRAPH ?g {
    VALUES ?sub { ${values} }
    VALUES ?super { ${values} }
    ?sub <${predicate}> ?super .
  }
  FILTER(?sub != ?super)
}
`;
      const moreDistant = new Set();
      try {
        const rel = (await sparqlQueryRaw(relQuery, endpoint)).results.bindings.filter((b) => bound(b, "sub", "super"));
        for (const b of rel) moreDistant.add(b.super.value);
      } catch (e) {
        // fall through - worst case, picks among all candidates below
      }
      const immediate = candidates.filter((c) => !moreDistant.has(c)).sort();
      nearest = (immediate.length ? immediate : [...candidates].sort())[0];
    }

    if (seen.has(nearest)) break; // cycle guard - shouldn't happen, don't hang if it does
    seen.add(nearest);
    chain.push(nearest);
    current = nearest;
  }
  return chain.reverse(); // root-first
}

// --- top-level queries -----------------------------------------------------

export async function fetchResource(iri, graphs, endpoint) {
  const valuesClause = await graphValuesClause(graphs, endpoint);
  // The OPTIONAL expands one level into a blank-node object's own
  // properties (guarded to blank nodes only - without that guard it would
  // also try to expand every *named* object, pulling in unrelated data).
  const outQ = `
SELECT DISTINCT ?g ?p ?o ?p2 ?val WHERE {
  ${valuesClause}GRAPH ?g {
    <${iri}> ?p ?o .
    OPTIONAL { FILTER(isBlank(?o)) . ?o ?p2 ?val }
  }
} ORDER BY ?p LIMIT ${OUT_IN_LIMIT}
`;
  // Symmetric idea for incoming blank-node subjects: instead of the bnode's
  // own properties, find what points *to* it (its "parent") - usually a
  // real named resource, giving context for an otherwise-anonymous node.
  const inQ = `
SELECT DISTINCT ?g ?s ?p ?parentPred ?parent WHERE {
  ${valuesClause}GRAPH ?g {
    ?s ?p <${iri}> .
    OPTIONAL { FILTER(isBlank(?s)) . ?parent ?parentPred ?s }
  }
} ORDER BY ?p LIMIT ${OUT_IN_LIMIT}
`;
  const typeQ = `SELECT DISTINCT ?g ?type WHERE { ${valuesClause}GRAPH ?g { <${iri}> a ?type } }`;

  const [outData, inData, typeData, breadcrumbIris] = await Promise.all([
    sparqlQueryRaw(outQ, endpoint),
    sparqlQueryRaw(inQ, endpoint),
    sparqlQueryRaw(typeQ, endpoint),
    fetchPartOfChain(iri, graphs, endpoint),
  ]);
  const outBindings = outData.results.bindings.filter((b) => bound(b, "g", "p", "o"));
  const inBindings = inData.results.bindings.filter((b) => bound(b, "g", "s", "p"));
  const typeBindings = typeData.results.bindings.filter((b) => bound(b, "g", "type"));

  const needsClassExpr = outBindings.some(
    (b) => MANCHESTER_TRIGGER_PREDICATES.includes(b.p.value) && b.o.type === "bnode"
  );
  let classExprEdges = new Map(), classExprIris = new Set();
  if (needsClassExpr) {
    [classExprEdges, classExprIris] = await fetchClassExpressionEdges(iri, graphs, endpoint);
  }

  const allIris = new Set([iri, ...classExprIris, ...breadcrumbIris]);
  for (const b of typeBindings) allIris.add(b.type.value);
  for (const b of outBindings) {
    allIris.add(b.p.value);
    if (b.o.type === "uri") allIris.add(b.o.value);
    if ("p2" in b) allIris.add(b.p2.value);
    if ("val" in b && b.val.type === "uri") allIris.add(b.val.value);
  }
  for (const b of inBindings) {
    allIris.add(b.p.value);
    if (b.s.type === "uri") allIris.add(b.s.value);
    if ("parentPred" in b) allIris.add(b.parentPred.value);
    if ("parent" in b && b.parent.type === "uri") allIris.add(b.parent.value);
  }

  const labels = await resolveLabels(allIris, endpoint);

  const outgoingList = groupWithGraphs(outBindings, "o", labels, ["p2", "val", "properties"])
    .map((g) => ({ predicate: g.predicate, objects: g.items }));
  if (classExprEdges.size) {
    for (const group of outgoingList) {
      if (!MANCHESTER_TRIGGER_PREDICATES.includes(group.predicate.iri)) continue;
      for (const obj of group.objects) {
        if (obj.kind === "bnode" && obj.graphs.length) {
          obj.manchester = renderClassExpr(
            { type: "bnode", value: obj.id }, classExprEdges, labels, obj.graphs[0].iri
          );
        }
      }
    }
  }
  const incomingList = groupWithGraphs(inBindings, "s", labels, ["parentPred", "parent", "parents"])
    .map((g) => ({ predicate: g.predicate, subjects: g.items }));

  const typesByIri = new Map();
  const excludedTypes = new Set(CONFIG.excluded_types);
  for (const b of typeBindings) {
    const t = b.type.value;
    if (excludedTypes.has(t)) continue;
    if (!typesByIri.has(t)) typesByIri.set(t, new Set());
    typesByIri.get(t).add(b.g.value);
  }
  const orderedTypeIris = await orderTypesByHierarchy([...typesByIri.keys()], graphs, endpoint);
  const types = orderedTypeIris.map((t) => ({
    iri: t,
    curie: curie(t),
    label: labels[t] ?? null,
    graphs: [...typesByIri.get(t)]
      .map((g) => ({ iri: g, short: shortGraphName(g) }))
      .sort((a, b) => (a.short < b.short ? -1 : a.short > b.short ? 1 : 0)),
  }));

  // Different curriculum-variant IRIs (e.g. a "LehrplanPLUS" vs. an older
  // document's node for what's conceptually the same subject) can sit right
  // next to each other in the chain and resolve to the identical label -
  // collapse an adjacent repeat rather than showing "Mathematik 1/2 >
  // Mathematik 1/2" (keeping the one closer to the root, i.e. the one
  // encountered first in this root-first order).
  const breadcrumb = [];
  for (const p of breadcrumbIris) {
    const label = labels[p] ?? null;
    const prev = breadcrumb[breadcrumb.length - 1];
    if (prev && prev.label && label && prev.label === label) continue;
    breadcrumb.push({ iri: p, curie: curie(p), label });
  }

  return {
    iri,
    curie: curie(iri),
    label: labels[iri] ?? null,
    types,
    breadcrumb,
    outgoing: outgoingList,
    incoming: incomingList,
    outgoing_truncated: outBindings.length >= OUT_IN_LIMIT,
    incoming_truncated: inBindings.length >= OUT_IN_LIMIT,
  };
}

/** A few example classes and labeled resources that actually exist in
 * `graphs` - used to help someone who filtered to a graph and then hit an
 * empty result (e.g. from a search or a direct link) figure out what *is*
 * there instead. */
export async function graphExamples(graphs, endpoint, limit = 8) {
  const valuesClause = await graphValuesClause(graphs, endpoint);
  const classQ = `
SELECT ?type (COUNT(DISTINCT ?s) AS ?n) WHERE {
  ${valuesClause}GRAPH ?g { ?s a ?type }
} GROUP BY ?type ORDER BY DESC(?n) LIMIT ${limit}
`;
  const resourceQ = `
SELECT DISTINCT ?s ?label WHERE {
  ${valuesClause}GRAPH ?g {
    { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label }
    UNION
    { ?s <http://www.w3.org/2004/02/skos/core#prefLabel> ?label }
  }
} LIMIT ${limit}
`;
  const [classData, resourceData] = await Promise.all([
    sparqlQueryRaw(classQ, endpoint),
    sparqlQueryRaw(resourceQ, endpoint),
  ]);
  const classBindings = classData.results.bindings.filter((b) => bound(b, "type", "n"));
  const resourceBindings = resourceData.results.bindings.filter((b) => bound(b, "s", "label"));

  const labels = await resolveLabels(classBindings.map((b) => b.type.value), endpoint);
  const classes = classBindings.map((b) => ({
    iri: b.type.value, curie: curie(b.type.value),
    label: labels[b.type.value] ?? null, count: parseInt(b.n.value, 10),
  }));
  const resources = resourceBindings.map((b) => ({
    iri: b.s.value, curie: curie(b.s.value), label: b.label.value,
  }));
  return { classes, resources };
}

export async function suggest(q, graphs, endpoint, limit = 15) {
  const esc = sparqlEscapeString(q);
  const valuesClause = await graphValuesClause(graphs, endpoint);
  const labelPattern = graphs && graphs.length
    ? `GRAPH ?g { { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label } UNION { ?s <http://www.w3.org/2004/02/skos/core#prefLabel> ?label } }`
    : `{ ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label } UNION { ?s <http://www.w3.org/2004/02/skos/core#prefLabel> ?label }`;
  // Plain CONTAINS has no notion of relevance, so a short exact-match label
  // (e.g. "Mathematik") can get buried under long unrelated labels that
  // merely happen to contain the word somewhere in a paragraph. Rank exact
  // matches first, then prefix matches, then shortest-remaining as a cheap
  // relevance proxy (concise concept labels vs. long descriptive ones).
  const query = `
SELECT DISTINCT ?s ?label WHERE {
  ${valuesClause}${labelPattern}
  FILTER(CONTAINS(LCASE(STR(?label)), LCASE("${esc}")))
}
ORDER BY (!(LCASE(STR(?label)) = LCASE("${esc}"))) (!(STRSTARTS(LCASE(STR(?label)), LCASE("${esc}")))) STRLEN(STR(?label))
LIMIT ${limit}
`;
  const data = await sparqlQueryRaw(query, endpoint);
  return data.results.bindings
    .filter((b) => bound(b, "s", "label"))
    .map((b) => ({ iri: b.s.value, curie: curie(b.s.value), label: b.label.value }));
}
