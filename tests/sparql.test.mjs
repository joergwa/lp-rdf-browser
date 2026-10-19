// Offline unit/regression tests for sparql.js - no live SPARQL endpoint
// needed. `fetch` is replaced with a small in-memory mock per test (or per
// group), so these run anywhere Node does.
//
// Run:  node --test tests/
//
// Scope: the "trickier logic" this app got wrong at least once during
// development and is worth guarding against regressing - Manchester syntax
// rendering, the "part of"/"has part" transitive-shortcut handling, and
// type-hierarchy ordering - plus the small pure helpers everything else
// builds on. This is not exhaustive coverage of sparql.js; it's the parts
// that are easy to get subtly wrong and hard to notice when it happens.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as Sparql from "../sparql.js";

const { _internal } = Sparql;

// --- fetch mock ----------------------------------------------------------
// handlers: array of { match: (url, opts) => boolean, response: jsonValue }.
// The first match wins; an unmatched request throws loudly rather than
// silently returning something misleading.
function mockFetch(handlers) {
  globalThis.fetch = async (url, opts = {}) => {
    const key = String(url);
    for (const h of handlers) {
      if (h.match(key, opts)) {
        const body = typeof h.response === "function" ? h.response(key, opts) : h.response;
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    throw new Error(`mockFetch: no handler matched ${opts.method || "GET"} ${key} body=${opts.body || ""}`);
  };
}

// sparqlQueryRaw's POST body is `new URLSearchParams({query}).toString()` -
// percent-encoded (and spaces become "+"), so a raw substring check against
// opts.body for anything with special characters (<, >, ?, a space) would
// never match. Decode it back to the literal query text instead.
function queryTextFromBody(opts) {
  if (!opts.body) return "";
  try {
    return new URLSearchParams(opts.body).get("query") || "";
  } catch {
    return "";
  }
}

function bindingsResponse(bindings) {
  return { head: { vars: [] }, results: { bindings } };
}

function uri(value) { return { type: "uri", value }; }
function lit(value, extra) { return { type: "literal", value, ...extra }; }
function bnode(value) { return { type: "bnode", value }; }

const EX = "http://example.org/data/";

// --- config + namespaces (shared fixture, loaded once) --------------------

before(async () => {
  mockFetch([
    {
      match: (url) => url === "config.json",
      response: {
        title: "Test Deployment",
        endpoint: "mock://default",
        namespaces_file: "data/namespaces.json",
        graph_short_prefix: EX,
        excluded_graphs: [],
        label_lang_preference: ["de", null, "en"],
        excluded_types: ["http://www.w3.org/2002/07/owl#Thing"],
        part_of_predicate: EX + "partOf",
        has_part_predicate: EX + "hasPart",
        impressum_url: "",
        impressum_label: "Impressum",
      },
    },
    {
      match: (url) => url === "data/namespaces.json",
      response: {
        owl: "http://www.w3.org/2002/07/owl#",
        rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        rdfs: "http://www.w3.org/2000/01/rdf-schema#",
        ex: EX,
        "ex-sub": EX + "sub/", // a longer, more specific prefix under `ex`
      },
    },
  ]);
  await Sparql.loadConfig();
});

// --- curie() / shortGraphName() -------------------------------------------

test("curie() picks the longest matching namespace", () => {
  assert.equal(Sparql.curie(EX + "Foo"), "ex:Foo");
  assert.equal(Sparql.curie(EX + "sub/Bar"), "ex-sub:Bar"); // longer prefix wins over `ex`
  assert.equal(Sparql.curie("http://unknown.example/x"), null);
});

test("shortGraphName() strips the configured prefix entirely", () => {
  assert.equal(Sparql.shortGraphName(EX + "sn/inferences"), "sn/inferences");
  assert.equal(Sparql.shortGraphName(EX), "/"); // bare prefix with nothing after it
});

test("shortGraphName() falls back to a last-segments guess outside the prefix", () => {
  assert.equal(Sparql.shortGraphName("http://other.example/a/b/c"), "b/c");
});

// --- predicateSortKey() / property ordering --------------------------------

test("predicateSortKey pins has_part/part_of adjacent regardless of alphabetical position", () => {
  const hasPart = EX + "hasPart";
  const partOf = EX + "partOf";
  const predicates = [EX + "zzz", partOf, EX + "aaa", hasPart, EX + "mmm"];
  const sorted = [...predicates].sort((a, b) => {
    const ka = _internal.predicateSortKey(a), kb = _internal.predicateSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const hpIdx = sorted.indexOf(hasPart);
  const poIdx = sorted.indexOf(partOf);
  assert.equal(poIdx, hpIdx + 1, "part_of must come immediately after has_part");
});

// --- describeNode() / nodeIdentity() ---------------------------------------

test("describeNode distinguishes uri/bnode/literal and carries lang/datatype", () => {
  const labels = { [EX + "Foo"]: "Foo label" };
  assert.deepEqual(_internal.describeNode(uri(EX + "Foo"), labels),
    { kind: "uri", iri: EX + "Foo", curie: "ex:Foo", label: "Foo label" });
  assert.deepEqual(_internal.describeNode(bnode("b1"), labels), { kind: "bnode", id: "b1" });
  assert.deepEqual(_internal.describeNode(lit("hello", { "xml:lang": "en" }), labels),
    { kind: "literal", value: "hello", lang: "en" });
  assert.deepEqual(_internal.describeNode(lit("42", { datatype: "http://www.w3.org/2001/XMLSchema#integer" }), labels),
    { kind: "literal", value: "42", datatype: "http://www.w3.org/2001/XMLSchema#integer" });
});

test("nodeIdentity scopes blank nodes to their graph", () => {
  const b1 = { kind: "bnode", id: "x" };
  assert.notEqual(_internal.nodeIdentity(b1, "graphA"), _internal.nodeIdentity(b1, "graphB"),
    "the same bnode label in two different graphs must not collide");
  assert.equal(_internal.nodeIdentity(b1, "graphA"), _internal.nodeIdentity(b1, "graphA"));
});

// --- groupWithGraphs() ------------------------------------------------------

test("groupWithGraphs merges the same (predicate, value) seen in two graphs into one entry", () => {
  const labels = {};
  const bindings = [
    { p: uri(EX + "p1"), g: uri(EX + "g1"), o: uri(EX + "v1") },
    { p: uri(EX + "p1"), g: uri(EX + "g2"), o: uri(EX + "v1") }, // same predicate+value, different graph
  ];
  const result = _internal.groupWithGraphs(bindings, "o", labels);
  assert.equal(result.length, 1);
  assert.equal(result[0].items.length, 1, "one merged value, not two rows");
  assert.deepEqual(result[0].items[0].graphs.map((g) => g.iri).sort(), [EX + "g1", EX + "g2"]);
});

test("groupWithGraphs attaches a one-level expansion for a blank-node value", () => {
  const labels = {};
  const bindings = [
    { p: uri(EX + "hasRestriction"), g: uri(EX + "g1"), o: bnode("b1"), p2: uri(EX + "onProperty"), val: uri(EX + "someProp") },
  ];
  const result = _internal.groupWithGraphs(bindings, "o", labels, ["p2", "val", "properties"]);
  const bnodeItem = result[0].items[0];
  assert.equal(bnodeItem.kind, "bnode");
  assert.equal(bnodeItem.properties.length, 1);
  assert.equal(bnodeItem.properties[0].predicate.iri, EX + "onProperty");
  assert.equal(bnodeItem.properties[0].value.iri, EX + "someProp");
});

test("groupWithGraphs drops a binding missing a required variable rather than throwing", () => {
  const labels = {};
  const bindings = [{ p: uri(EX + "p1"), g: uri(EX + "g1") }]; // no "o"
  assert.deepEqual(_internal.groupWithGraphs(bindings, "o", labels), []);
});

// --- flattenRdfList() / renderClassExpr() (Manchester syntax) --------------
// These are pure given a hand-built `edges` Map: edges.get(JSON.stringify([graph, bnodeId]))
// -> [[predicateIri, valueBinding], ...], mirroring fetchClassExpressionEdges's shape.

function edgesFrom(graph, map) {
  // map: { bnodeId: [[predIri, binding], ...] }
  const m = new Map();
  for (const [id, props] of Object.entries(map)) m.set(JSON.stringify([graph, id]), props);
  return m;
}

const G = "g1";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL = (n) => "http://www.w3.org/2002/07/owl#" + n;

test("renderClassExpr: someValuesFrom restriction", () => {
  const edges = edgesFrom(G, {
    r1: [[OWL("onProperty"), uri(EX + "partOf")], [OWL("someValuesFrom"), uri(EX + "Whole")]],
  });
  const labels = { [EX + "partOf"]: "part of", [EX + "Whole"]: "Whole" };
  const out = _internal.renderClassExpr(bnode("r1"), edges, labels, G);
  assert.equal(out, "part of some Whole");
});

test("renderClassExpr: qualified cardinality with onClass", () => {
  const edges = edgesFrom(G, {
    r1: [
      [OWL("onProperty"), uri(EX + "hasPart")],
      [OWL("minQualifiedCardinality"), lit("2", { datatype: "http://www.w3.org/2001/XMLSchema#nonNegativeInteger" })],
      [OWL("onClass"), uri(EX + "Chapter")],
    ],
  });
  const labels = { [EX + "hasPart"]: "has part", [EX + "Chapter"]: "Chapter" };
  const out = _internal.renderClassExpr(bnode("r1"), edges, labels, G);
  assert.equal(out, "has part min 2 Chapter");
});

test("renderClassExpr: intersectionOf over an rdf:list", () => {
  // Build an rdf:list: list1 -> (A, list2 -> (B, nil))
  const RDF = (n) => "http://www.w3.org/1999/02/22-rdf-syntax-ns#" + n;
  const edges = edgesFrom(G, {
    r1: [[OWL("intersectionOf"), bnode("list1")]],
    list1: [[RDF("first"), uri(EX + "A")], [RDF("rest"), bnode("list2")]],
    list2: [[RDF("first"), uri(EX + "B")], [RDF("rest"), uri(RDF("nil"))]],
  });
  const labels = { [EX + "A"]: "A", [EX + "B"]: "B" };
  const out = _internal.renderClassExpr(bnode("r1"), edges, labels, G);
  assert.equal(out, "(A and B)");
});

test("renderClassExpr: empty intersectionOf list reports missing data, not a guess", () => {
  const edges = edgesFrom(G, {
    r1: [[OWL("intersectionOf"), bnode("list1")]],
    // list1 deliberately has no rdf:first/rdf:rest data in this graph
  });
  const out = _internal.renderClassExpr(bnode("r1"), edges, {}, G);
  assert.equal(out, "(intersectionOf: list has no data in this graph)");
});

test("renderClassExpr: complementOf and oneOf", () => {
  const RDF = (n) => "http://www.w3.org/1999/02/22-rdf-syntax-ns#" + n;
  const edges = edgesFrom(G, {
    r1: [[OWL("complementOf"), uri(EX + "Bad")]],
    r2: [[OWL("oneOf"), bnode("list1")]],
    list1: [[RDF("first"), uri(EX + "X")], [RDF("rest"), uri(RDF("nil"))]],
  });
  const labels = { [EX + "Bad"]: "Bad", [EX + "X"]: "X" };
  assert.equal(_internal.renderClassExpr(bnode("r1"), edges, labels, G), "not Bad");
  assert.equal(_internal.renderClassExpr(bnode("r2"), edges, labels, G), "{X}");
});

test("renderClassExpr: onProperty present but no value-constraint is reported, not guessed", () => {
  const edges = edgesFrom(G, { r1: [[OWL("onProperty"), uri(EX + "p")]] });
  const out = _internal.renderClassExpr(bnode("r1"), edges, { [EX + "p"]: "p" }, G);
  assert.equal(out, "p ... (restriction incomplete in this graph)");
});

test("renderClassExpr: a blank node with no properties at all vs. depth exceeded are distinct messages", () => {
  const edges = edgesFrom(G, {}); // r1 has no entry at all
  assert.equal(_internal.renderClassExpr(bnode("r1"), edges, {}, G), "(no data for this node in this graph)");
  const deepEdges = edgesFrom(G, { r1: [[OWL("onProperty"), uri(EX + "p")]] });
  assert.equal(_internal.renderClassExpr(bnode("r1"), deepEdges, {}, G, 6), "(...)", "CLASS_EXPR_DEPTH is 6");
});

test("renderClassExpr: unrecognized blank-node shape says so plainly", () => {
  const edges = edgesFrom(G, { r1: [[EX + "someRandomPredicate", uri(EX + "x")]] });
  assert.equal(_internal.renderClassExpr(bnode("r1"), edges, {}, G), "(unrecognized expression)");
});

test("flattenRdfList stops at a cycle instead of looping forever", () => {
  const RDF = (n) => "http://www.w3.org/1999/02/22-rdf-syntax-ns#" + n;
  // list1 -> list2 -> list1 (cycle)
  const edges = edgesFrom(G, {
    list1: [[RDF("first"), uri(EX + "A")], [RDF("rest"), bnode("list2")]],
    list2: [[RDF("first"), uri(EX + "B")], [RDF("rest"), bnode("list1")]],
  });
  const items = _internal.flattenRdfList(bnode("list1"), edges, G);
  assert.deepEqual(items.map((i) => i.value), [EX + "A", EX + "B"]); // stops once it would repeat
});

// --- orderTypesByHierarchy(): type-hierarchy ordering ----------------------

test("orderTypesByHierarchy orders general-first via direct subClassOf edges", async () => {
  const A = EX + "A", B = EX + "B", C = EX + "C"; // A subClassOf B subClassOf C; D unrelated
  const D = EX + "D";
  const graphs = [EX + "g1"]; // explicit, so this doesn't fall back to a getDefaultGraphs() call
  mockFetch([
    {
      match: (url, opts) => url === "mock://order-test" && queryTextFromBody(opts).includes("subClassOf"),
      response: bindingsResponse([
        { sub: uri(A), super: uri(B) },
        { sub: uri(B), super: uri(C) },
      ]),
    },
  ]);
  const order = await _internal.orderTypesByHierarchy([A, B, C, D], graphs, "mock://order-test");
  // D has no relation to anything, so it's alphabetically placed among the
  // "ready" (indegree-0) set at each step; C/B/A must still appear in
  // general-to-specific order relative to each other.
  const idx = (x) => order.indexOf(x);
  assert.ok(idx(C) < idx(B) && idx(B) < idx(A), `expected C, B, A in that relative order, got ${order}`);
});

// --- fetchPartOfChain(): transitive-shortcut handling -----------------------
// Regression test for a real bug found during development: when the
// endpoint materializes the transitive closure of "part of" as direct
// triples, a single hop can return the true immediate parent *and* a more
// distant ancestor in the same result. Reproduces the exact shape of data
// that exposed this (see conversation history / README).

test("fetchPartOfChain picks the immediate parent at each hop, not a transitive shortcut", async () => {
  // Deliberately named so the *wrong* (alphabetically-first) answer would be
  // "aDistantRoot" - a naive "just sort and take [0]" implementation would
  // pick it directly and skip "zImmediateMid" entirely, so this only passes
  // with the real immediate-vs-distant filtering in place.
  const leaf = EX + "leaf";
  const mid = EX + "zImmediateMid"; // leaf's true immediate parent
  const root = EX + "aDistantRoot"; // leaf's grandparent, also directly reachable via materialized transitivity
  const graphs = [EX + "g1"];
  mockFetch([
    {
      // hop 1 from `leaf`: both `mid` (immediate) and `root` (transitive shortcut) come back
      match: (url, opts) => queryTextFromBody(opts).includes(`<${leaf}>`) && !queryTextFromBody(opts).includes("VALUES ?sub"),
      response: bindingsResponse([{ parent: uri(mid) }, { parent: uri(root) }]),
    },
    {
      // relation-among-candidates query for hop 1: mid partOf root (so root is "more distant")
      match: (url, opts) => queryTextFromBody(opts).includes("VALUES ?sub") && queryTextFromBody(opts).includes(mid),
      response: bindingsResponse([{ sub: uri(mid), super: uri(root) }]),
    },
    {
      // hop 2 from `mid`: only `root` left
      match: (url, opts) => queryTextFromBody(opts).includes(`<${mid}>`) && !queryTextFromBody(opts).includes("VALUES ?sub"),
      response: bindingsResponse([{ parent: uri(root) }]),
    },
    {
      // hop 3 from `root`: no further parent
      match: (url, opts) => queryTextFromBody(opts).includes(`<${root}>`) && !queryTextFromBody(opts).includes("VALUES ?sub"),
      response: bindingsResponse([]),
    },
  ]);
  const chain = await _internal.fetchPartOfChain(leaf, graphs, "mock://chain-test");
  assert.deepEqual(chain, [root, mid], "root-first, and mid must not be skipped");
});

// --- groupWithGraphs(): alphabetical item ordering --------------------------

test("groupWithGraphs sorts a predicate's values alphabetically by display text", () => {
  const labels = { [EX + "b"]: "Banana", [EX + "a"]: "Apple", [EX + "c"]: "Cherry" };
  const bindings = [
    { p: uri(EX + "p1"), g: uri(EX + "g1"), o: uri(EX + "b") },
    { p: uri(EX + "p1"), g: uri(EX + "g1"), o: uri(EX + "a") },
    { p: uri(EX + "p1"), g: uri(EX + "g1"), o: uri(EX + "c") },
  ];
  const result = _internal.groupWithGraphs(bindings, "o", labels);
  assert.deepEqual(result[0].items.map((i) => i.label), ["Apple", "Banana", "Cherry"]);
});

test("groupWithGraphs sorts literal values by their own text, falling back from label", () => {
  const bindings = [
    { p: uri(EX + "p1"), g: uri(EX + "g1"), o: lit("Zebra") },
    { p: uri(EX + "p1"), g: uri(EX + "g1"), o: lit("Antelope") },
  ];
  const result = _internal.groupWithGraphs(bindings, "o", {});
  assert.deepEqual(result[0].items.map((i) => i.value), ["Antelope", "Zebra"]);
});

// --- resolveLabels() caching -------------------------------------------------

test("resolveLabels caches both hits and confirmed-absent labels across calls", async () => {
  const endpoint = "mock://label-cache-test";
  const known = EX + "known";
  const unlabeled = EX + "unlabeled";
  let fetchCount = 0;
  mockFetch([
    {
      match: (url, opts) => url === endpoint,
      response: (url, opts) => {
        fetchCount++;
        return bindingsResponse([{ s: uri(known), label: lit("Known") }]);
      },
    },
  ]);

  const first = await Sparql.resolveLabels([known, unlabeled], endpoint);
  assert.equal(fetchCount, 1);
  assert.deepEqual(first, { [known]: "Known" });

  const second = await Sparql.resolveLabels([known, unlabeled], endpoint);
  assert.equal(fetchCount, 1, "fully cached - no second network call");
  assert.deepEqual(second, { [known]: "Known" });
});

test("resolveLabels prefers German over untagged over English, per config", async () => {
  const endpoint = "mock://label-lang-test";
  const s = EX + "multiLang";
  mockFetch([
    {
      match: (url) => url === endpoint,
      response: bindingsResponse([
        { s: uri(s), label: lit("English label", { "xml:lang": "en" }) },
        { s: uri(s), label: lit("Deutsches Label", { "xml:lang": "de" }) },
        { s: uri(s), label: lit("Untagged label") },
      ]),
    },
  ]);
  const labels = await Sparql.resolveLabels([s], endpoint);
  assert.equal(labels[s], "Deutsches Label");
});
